import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import test from "node:test";
import express from "express";
import { createPool } from "../src/db/pool.mjs";
import { migrate } from "../src/db/migrate.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL;
const secret = "meta-test-secret";
const signature = (body) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
const message = (mid, timestamp = 1000) => ({ sender: { id: "customer" }, recipient: { id: "page" }, timestamp, message: { mid, text: "private customer text" } });
const body = (items, page = "page") => Buffer.from(JSON.stringify({ object: "page", entry: [{ id: page, messaging: items }] }));

test("durable Messenger ingress filters, deduplicates, orders and commits before HTTP acknowledgement", { skip: !databaseUrl }, async (t) => {
  const module = await import("../src/channels/meta/ingress.mjs").catch(() => ({}));
  assert.equal(typeof module.acceptMetaWebhook, "function", "durable ingress boundary is required");
  const { createMetaRouter } = await import("../src/http/meta-routes.mjs");
  const admin = createPool({ databaseUrl });
  const schema = `ingress_${randomUUID().replaceAll("-", "")}`;
  let pool, server;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(databaseUrl);
    url.searchParams.set("options", `-c search_path=${schema}`);
    pool = createPool({ databaseUrl: url.href });
    await migrate(pool);
    await pool.query("INSERT INTO meta_page_sources(id,organization_id,page_id,name,health) VALUES('source','org_default','page','Page','connected')");
    const accept = (rawBody, extra = {}) => module.acceptMetaWebhook({ pool, appSecret: secret, rawBody, signature: signature(rawBody), ...extra });
    const count = async (table) => (await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
    await t.test("authentication precedes parsing and exact bytes are signed", async () => {
      assert.equal((await accept(Buffer.from("{"), { signature: "sha256=bad" })).status, 403);
      assert.equal((await accept(Buffer.from("{"))).status, 400);
      const raw = body([message("unsigned")]);
      assert.equal((await accept(Buffer.concat([raw, Buffer.from(" ")]), { signature: signature(raw) })).status, 403);
      assert.equal(await count("messages"), 0);
    });
    await t.test("unsupported envelopes and events never create generation work", async () => {
      const cases = [body([{ ...message("echo"), message: { mid: "echo", is_echo: true, text: "x" } }]), body([{ ...message("read"), read: {} }, { ...message("delivery"), delivery: {} }]), body([{ ...message("file"), message: { mid: "file", attachments: [{ type: "file", payload: { url: "https://private.example" } }] } }]), body([{ ...message("mixed"), message: { mid: "mixed", text: "x", attachments: [{ type: "image", payload: { url: "https://private.example" } }] } }]), body([{ ...message("no-sender"), sender: {} }]), Buffer.from('{"object":"page","entry":{}}'), Buffer.from('{"object":"page","entry":[{"id":"page","messaging":{}}]}')];
      for (const raw of cases) assert.deepEqual(await accept(raw), { status: 200, acceptedEventIds: [] });
      assert.equal(await count("jobs"), 0);
    });
    await t.test("concurrent retries produce one durable message, revision, work item, job and redacted audit", async () => {
      const results = await Promise.all(Array.from({ length: 8 }, () => accept(body([message("mid_1")]))));
      assert.equal(results.flatMap((result) => result.acceptedEventIds).length, 1);
      for (const table of ["messages", "conversations", "work_items", "jobs", "audit_entries"]) assert.equal(await count(table), 1, table);
      const job = (await pool.query("SELECT kind,payload,retry_safe FROM jobs")).rows[0];
      assert.equal(job.kind, "analyze_work_item");
      assert.equal(job.payload.processingRevision, 1);
      assert.equal(job.retry_safe, true);
      const evidence = JSON.stringify((await pool.query("SELECT raw_evidence FROM messages")).rows) + JSON.stringify((await pool.query("SELECT details FROM audit_entries")).rows) + JSON.stringify(job);
      for (const value of ["private customer text", "customer", secret]) assert.equal(evidence.includes(value), false);
    });
    await t.test("conversation locking assigns order independently of event time and scopes identity", async () => {
      await Promise.all([accept(body([message("newer", 9000)])), accept(body([message("older", 1)]))]);
      assert.deepEqual((await pool.query("SELECT processing_revision FROM messages ORDER BY processing_revision")).rows.map((r) => r.processing_revision), [1, 2, 3]);
      assert.equal((await pool.query("SELECT provider_timestamp_ms FROM messages WHERE mid='older'")).rows[0].provider_timestamp_ms, "1");
      assert.equal((await pool.query("SELECT processing_revision FROM conversations")).rows[0].processing_revision, 3);
      await pool.query("INSERT INTO organizations(id,name) VALUES ('other','Other')");
      await pool.query("INSERT INTO meta_page_sources(id,organization_id,page_id,name,health) VALUES('other-source','other','page-other','Other Page','connected'),('source2','org_default','page2','Page 2','connected')");
      await accept(body([{ ...message("mid_1"), recipient: { id: "page-other" } }], "page-other"));
      await accept(body([{ ...message("mid_1"), recipient: { id: "page2" } }], "page2"));
      assert.equal(await count("conversations"), 3);
    });
    await t.test("job failure rolls back the entire batch and permits retry", async () => {
      const before = await count("messages");
      await pool.query("CREATE FUNCTION reject_ingress_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$; CREATE TRIGGER reject_ingress_job BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION reject_ingress_job()");
      assert.equal((await accept(body([message("rollback1"), message("rollback2")]))).status, 503);
      assert.equal(await count("messages"), before);
      assert.equal((await pool.query("SELECT processing_revision FROM conversations WHERE page_id='page' AND organization_id='org_default'")).rows[0].processing_revision, 3);
      await pool.query("DROP TRIGGER reject_ingress_job ON jobs");
      assert.equal((await accept(body([message("rollback1")]))).acceptedEventIds.length, 1);
    });
    await t.test("selected inbound bindings survive outbound health failures and unresolved bindings request retry", async () => {
      const before = await count("messages"), jobsBefore = await count("jobs");
      for (const health of ["unavailable", "expired", "revoked"]) {
        await pool.query("UPDATE meta_page_sources SET health=$1,expires_at=now()-interval '1 hour' WHERE id='source'", [health]);
        const raw = body([message(`health-${health}`)]);
        const accepted = await accept(raw);
        assert.equal(accepted.status, 200);
        assert.equal(accepted.acceptedEventIds.length, 1, health);
        assert.deepEqual(await accept(raw), { status: 200, acceptedEventIds: [] });
      }
      assert.equal(await count("messages"), before + 3);
      assert.equal(await count("jobs"), jobsBefore + 3);
      await pool.query("UPDATE meta_page_sources SET health='disconnected' WHERE id='source'");
      assert.deepEqual(await accept(body([message("disconnected")])), { status: 200, acceptedEventIds: [] });
      assert.equal((await accept(body([{ ...message("unknown"), recipient: { id: "unknown-page" } }], "unknown-page"))).status, 503);
      assert.equal(await count("messages"), before + 3);
      await pool.query("UPDATE meta_page_sources SET health='connected',expires_at=NULL WHERE id='source'");
      const unresolvedBatch = Buffer.from(JSON.stringify({ object: "page", entry: [
        { id: "page", messaging: [message("retry-bound")] },
        { id: "unknown-page", messaging: [{ ...message("retry-unbound"), recipient: { id: "unknown-page" } }] },
      ] }));
      assert.equal((await accept(unresolvedBatch)).status, 503);
      assert.equal(await count("messages"), before + 3, "a retryable unresolved batch must not partially commit");
      await pool.query("INSERT INTO meta_page_sources(id,organization_id,page_id,name,health) VALUES('resolved-source','org_default','unknown-page','Resolved Page','unavailable')");
      const retried = await accept(unresolvedBatch);
      assert.equal(retried.status, 200);
      assert.equal(retried.acceptedEventIds.length, 2);
      assert.equal(await count("messages"), before + 5);
    });
    await t.test("raw HTTP route commits before 200 and safe challenge rejects invalid tokens", async () => {
      const app = express();
      app.use(createMetaRouter({ pool, appSecret: secret, verifyToken: "verify" }));
      app.use(express.json());
      server = app.listen(0, "127.0.0.1");
      await new Promise((resolve) => server.once("listening", resolve));
      const base = `http://127.0.0.1:${server.address().port}/webhooks/meta`;
      assert.equal((await fetch(base + "?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42")).status, 403);
      const challenge = await fetch(base + "?hub.mode=subscribe&hub.verify_token=verify&hub.challenge=%3Cscript%3E");
      assert.match(challenge.headers.get("content-type"), /^text\/plain/);
      assert.equal(await challenge.text(), "<script>");
      const raw = body([message("http")]);
      const response = await fetch(base, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": signature(raw) }, body: raw });
      assert.equal(response.status, 200);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM jobs WHERE payload->>'messageId' IN (SELECT id FROM messages WHERE mid='http')")).rows[0].n, 1);
      await pool.query("CREATE TRIGGER reject_ingress_job BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION reject_ingress_job()");
      const failedRaw = body([message("http-failure")]);
      const failed = await fetch(base, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": signature(failedRaw) }, body: failedRaw });
      assert.equal(failed.status, 503);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM messages WHERE mid='http-failure'")).rows[0].n, 0);
    });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});
