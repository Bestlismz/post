import assert from "node:assert/strict";
import test from "node:test";
import { createHmac, randomUUID } from "node:crypto";
import { createPool } from "../src/db/pool.mjs";
import { migrate } from "../src/db/migrate.mjs";
import { withTransaction } from "../src/db/transaction.mjs";
import { acceptMetaWebhook } from "../src/channels/meta/ingress.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL;
test("Inbox projections and conversation revision boundary", { skip: !databaseUrl }, async (t) => {
  const queries = await import("../src/inbox/queries.mjs").catch(() => ({}));
  const repository = await import("../src/inbox/repository.mjs").catch(() => ({}));
  assert.equal(typeof queries.createInboxQueries, "function", "Inbox query boundary must exist");
  const admin = createPool({ databaseUrl });
  const schema = `inbox_${randomUUID().replaceAll("-", "")}`;
  let pool;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(databaseUrl);
    url.searchParams.set("options", `-c search_path=${schema}`);
    pool = createPool({ databaseUrl: url.href });
    await migrate(pool);
    await pool.query("INSERT INTO organizations(id,name) VALUES('other','Other'); INSERT INTO meta_page_sources(id,organization_id,page_id,name,health) VALUES('source','org_default','page-secret','Rentals','connected'),('source2','org_default','page2','Second','connected'),('other-source','other','other-page','Other','connected')");
    const actor = { id: "admin", organizationId: "org_default", role: "admin" };
    const inbox = queries.createInboxQueries({ pool });
    const receive = async (mid, sender = "private-psid", page = "page-secret", timestamp = 1000) => {
      const rawBody = Buffer.from(JSON.stringify({ object: "page", entry: [{ id: page, messaging: [{ sender: { id: sender }, recipient: { id: page }, timestamp, message: { mid, text: `Looking for room ${mid}` } }] }] }));
      const result = await acceptMetaWebhook({ pool, rawBody, appSecret: "secret", signature: `sha256=${createHmac("sha256", "secret").update(rawBody).digest("hex")}` });
      assert.equal(result.status, 200);
    };
    await receive("first");
    await receive("second", "private-psid", "page-secret", 1);
    await receive("third", "another-psid");
    await receive("fourth", "private-psid", "page2");
    await receive("outside", "private-psid", "other-page");
    await pool.query("UPDATE work_items SET created_at='2026-10-01T00:00:00.123456Z'");
    let first;
    await t.test("identical timestamps paginate with no gaps or duplicates and explicit safe DTOs", async () => {
      first = await inbox.listInbox({ limit: 2 }, actor);
      assert.equal(first.items.length, 2);
      assert.ok(first.nextCursor);
      const second = await inbox.listInbox({ limit: 2, cursor: first.nextCursor }, actor);
      assert.equal(second.items.length, 2);
      assert.equal(second.nextCursor, null);
      const ids = [...first.items, ...second.items].map((item) => item.id);
      assert.equal(new Set(ids).size, 4);
      assert.deepEqual(ids, [...ids].sort().reverse());
      const detail = await inbox.getInboxItem(first.items[0].id, actor);
      assert.ok(detail.timeline.length);
      assert.ok(detail.participant.id);
      assert.equal(detail.participant.label, "Messenger customer");
      const serialized = JSON.stringify({ first, second, detail });
      for (const forbidden of ["private-psid", "another-psid", "page-secret", "raw_evidence", "provider_timestamp", "organization_id", "ciphertext", "envelope", "outside"]) assert.equal(serialized.includes(forbidden), false, forbidden);
      assert.deepEqual(Object.keys(first.items[0]).sort(), ["channel", "conversationId", "createdAt", "id", "message", "participant", "processingRevision", "source", "status", "summary"].sort());
    });
    await t.test("list summary exposes normalized durable requirements and explicit nulls without provider identities", async () => {
      await pool.query(`INSERT INTO reply_versions(id,organization_id,work_item_id,conversation_id,conversation_revision,version,content,context)
        SELECT 'summary-reply',w.organization_id,w.id,w.conversation_id,w.processing_revision,1,'{"text":"safe"}',
          '{"extraction":{"requirements":{"district":"  อโศก  ","budgetMax":20000}},"providerId":"page-secret"}'::jsonb
        FROM work_items w JOIN messages m ON m.organization_id=w.organization_id AND m.id=w.message_id
        WHERE w.organization_id='org_default' AND m.mid='first'`);
      const populated = (await inbox.listInbox({ search: "first" }, actor)).items[0];
      const empty = (await inbox.listInbox({ search: "third" }, actor)).items[0];
      assert.deepEqual(populated.summary, { location: "อโศก", budgetMax: 20000, assignee: null });
      assert.deepEqual(empty.summary, { location: null, budgetMax: null, assignee: null });
      assert.equal(JSON.stringify(populated).includes("page-secret"), false);
    });
    await t.test("source/channel/search filters retain disconnected source history", async () => {
      await pool.query("UPDATE meta_page_sources SET health='disconnected' WHERE id='source'");
      const result = await inbox.listInbox({ sourceId: "source", channel: "messenger", search: "second" }, actor);
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0].source.health, "disconnected");
      const detail = await inbox.getInboxItem(result.items[0].id, actor);
      assert.deepEqual(detail.timeline.map((message) => message.processingRevision), [1, 2]);
      assert.equal((await inbox.listInbox({ sourceId: "source2" }, actor)).items.length, 1);
      await pool.query("UPDATE meta_page_sources SET health='connected' WHERE id='source'");
    });
    await t.test("invalid cursors and actor scopes fail closed at query boundary", async () => {
      for (const cursor of ["!", "e30", first.nextCursor + "=", Buffer.from(JSON.stringify({ v: 1, at: "invalid", id: "x" })).toString("base64url")]) await assert.rejects(inbox.listInbox({ cursor }, actor), { status: 400 });
      const position = JSON.parse(Buffer.from(first.nextCursor, "base64url"));
      for (const change of [{ id: "\u0000" }, { at: "0000-01-01T00:00:00.000000Z" }, { at: "2026-02-31T00:00:00.000000Z" }, { extra: true }]) {
        const cursor = Buffer.from(JSON.stringify({ ...position, ...change })).toString("base64url");
        await assert.rejects(inbox.listInbox({ cursor }, actor), { status: 400 });
      }
      await assert.rejects(inbox.listInbox({ cursor: first.nextCursor, search: "different" }, actor), { status: 400 });
      for (const limit of [0, -1, 101, 1.5, "2"]) await assert.rejects(inbox.listInbox({ limit }, actor), { status: 400 });
      await assert.rejects(inbox.listInbox({ channel: "other" }, actor), { status: 400 });
      await assert.rejects(inbox.listInbox({}, null), { status: 401 });
      await assert.rejects(inbox.listInbox({}, { ...actor, role: "intruder" }), { status: 403 });
      await assert.rejects(inbox.listInbox({}, { ...actor, organizationId: "" }), { status: 401 });
      assert.equal(await inbox.getInboxItem(first.items[0].id, { ...actor, organizationId: "other" }), null);
      assert.equal((await inbox.listInbox({ sourceId: "other-source" }, actor)).items.length, 0);
      await assert.rejects(inbox.listInbox({ cursor: first.nextCursor }, { ...actor, organizationId: "other" }), { status: 400 });
    });
    await t.test("query text rejects controls before SQL and preserves Thai and Unicode", async () => {
      for (const control of ["\u0000", "\n", "\u001f", "\u007f", "\u0085", "\ud800"]) {
        for (const filter of ["search", "sourceId", "channel"]) await assert.rejects(inbox.listInbox({ [filter]: `room${control}` }, actor), { status: 400 });
        await assert.rejects(inbox.getInboxItem(`item${control}`, actor), { status: 400 });
        const invalidActor = { ...actor, organizationId: `org${control}` };
        await assert.rejects(inbox.listInbox({}, invalidActor), { status: 400 });
        await assert.rejects(inbox.getInboxItem(first.items[0].id, invalidActor), { status: 400 });
        await assert.rejects(withTransaction(pool, (tx) => repository.claimConversationRevision(tx, `conversation${control}`, 1, actor)), { status: 400 });
        const position = JSON.parse(Buffer.from(first.nextCursor, "base64url"));
        for (const field of ["at", "id", "scope"]) {
          const cursor = Buffer.from(JSON.stringify({ ...position, [field]: `invalid${control}` })).toString("base64url");
          await assert.rejects(inbox.listInbox({ cursor }, actor), { status: 400 });
        }
      }
      await pool.query("UPDATE messages SET text='ห้องใกล้รถไฟฟ้า 🏠' WHERE mid='first'");
      assert.equal((await inbox.listInbox({ search: "ห้องใกล้รถไฟฟ้า 🏠" }, actor)).items.length, 1);
      assert.equal((await inbox.listInbox({ sourceId: "แหล่งข้อมูล 🏠" }, actor)).items.length, 0);
      assert.equal(await inbox.getInboxItem("รายการ 🏠", actor), null);
    });
    await t.test("new inbound supersedes a generation claim and stale commits and claims reject", async () => {
      const { rows: [conversation] } = await pool.query("SELECT id FROM conversations WHERE page_id='page-secret' AND psid='private-psid'");
      const old = await withTransaction(pool, (tx) => repository.claimConversationRevision(tx, conversation.id, 2, actor));
      await receive("new", "private-psid", "page-secret", 0);
      await assert.rejects(withTransaction(pool, (tx) => repository.claimConversationRevision(tx, conversation.id, 2, actor)), /superseded/i);
      let committed = false;
      await assert.rejects(withTransaction(pool, (tx) => repository.commitConversationRevision(tx, old, actor, async () => { committed = true; })), /superseded/i);
      assert.equal(committed, false);
      await assert.rejects(withTransaction(pool, (tx) => repository.claimConversationRevision(tx, conversation.id, 3, { ...actor, organizationId: "other" })), { status: 404 });
      await assert.rejects(withTransaction(pool, (tx) => repository.claimConversationRevision(tx, conversation.id, 3, { ...actor, role: "viewer" })), { status: 403 });
      const fresh = await withTransaction(pool, (tx) => repository.claimConversationRevision(tx, conversation.id, 3, actor));
      assert.equal(await withTransaction(pool, (tx) => repository.commitConversationRevision(tx, fresh, actor, async () => "saved")), "saved");
    });
    await t.test("revision commit serializes with concurrent inbound while the row lock is held", async () => {
      const { rows: [conversation] } = await pool.query("SELECT id FROM conversations WHERE page_id='page-secret' AND psid='private-psid'");
      let release, entered;
      const gate = new Promise((resolve) => { release = resolve; });
      const ready = new Promise((resolve) => { entered = resolve; });
      const write = withTransaction(pool, async (tx) => {
        const { rows: [{ pid }] } = await tx.query("SELECT pg_backend_pid() AS pid");
        const claim = await repository.claimConversationRevision(tx, conversation.id, 3, actor);
        return repository.commitConversationRevision(tx, claim, actor, async () => { entered(pid); await gate; return "saved before inbound"; });
      });
      const pid = await ready;
      let incomingFinished = false;
      const incoming = receive("concurrent").then(() => { incomingFinished = true; });
      try {
        let blocked = false;
        for (let i = 0; i < 100 && !blocked; i++) {
          blocked = (await admin.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked", [pid])).rows[0].blocked;
          if (!blocked) await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.equal(blocked, true, "ingress must wait on the revision transaction's row lock");
        assert.equal(incomingFinished, false);
      } finally { release(); }
      assert.equal(await write, "saved before inbound");
      await incoming;
      assert.equal((await pool.query("SELECT processing_revision FROM conversations WHERE id=$1", [conversation.id])).rows[0].processing_revision, 4);
    });
  } finally {
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});
