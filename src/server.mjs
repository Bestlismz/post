import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import httpProxy from "http-proxy";
import next from "next";
import { createSiteBrowser } from "./browser.mjs";
import { createDraftGenerator } from "./generator.mjs";
import { createGroupService } from "./groups.mjs";
import { createMessengerFixture } from "./messenger-fixture.mjs";
import { createMessengerGenerator } from "./messenger-generator.mjs";
import { createMessengerWorker } from "./messenger-worker.mjs";
import { createMetaClient } from "./meta-client.mjs";
import { normalizePageEvents, verifyChallenge, verifySignature } from "./meta-webhook.mjs";
import { createRelevanceAnalyzer } from "./relevance.mjs";
import { decideReplyAction, renderReplyProfile, validateReplyProfile } from "./reply-policy.mjs";
import { createStore, digest, id, preserveSubmittedTargetKeys, publicState } from "./state.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const port = Number(process.env.PORT ?? 3000);
const mode = process.env.POC_MODE === "live" ? "live" : "fixture";
const model = process.env.OPENAI_MODEL || "gpt-5-mini";
const liveSubmissionEnabled = process.env.POC_LIVE_SUBMISSION === "true";
const stateDir = process.env.STATE_DIR ?? path.join(root, "state");
const store = createStore(stateDir);
const desktopSockets = new Set();
let browserBusy = false;
let browserOperation = {
  status: "idle",
  phase: "idle",
  current: 0,
  total: 0,
  detail: "Waiting for the next browser operation",
  updatedAt: new Date().toISOString(),
};

const site = createSiteBrowser({
  cdpUrl: process.env.CHROME_CDP_URL ?? "http://127.0.0.1:9222",
  mode,
  liveSubmissionEnabled,
  evidencePath: (evidenceId) => store.evidencePath(evidenceId),
});
const generateText = createDraftGenerator({ apiKey: process.env.OPENAI_API_KEY, model });
const analyzeRelevance = createRelevanceAnalyzer({ apiKey: process.env.OPENAI_API_KEY, model });
const groups = createGroupService({ store, site, analyze: analyzeRelevance, withBrowserLease, onProgress: updateBrowserOperation });
const metaConfig = {
  pageId: process.env.META_PAGE_ID || (mode === "fixture" ? "fixture-page" : ""),
  pageAccessToken: process.env.META_PAGE_ACCESS_TOKEN || (mode === "fixture" ? "fixture-token" : ""),
  appSecret: process.env.META_APP_SECRET || (mode === "fixture" ? "fixture-secret" : ""),
  verifyToken: process.env.META_VERIFY_TOKEN || (mode === "fixture" ? "fixture-verify" : ""),
};
const messengerGenerator = createMessengerGenerator({ apiKey: process.env.OPENAI_API_KEY, model });
const nextApp = next({ dev: false, dir: root });
await nextApp.prepare();
const nextHandler = nextApp.getRequestHandler();
const app = express();
const server = http.createServer(app);
const proxy = httpProxy.createProxyServer({ target: "http://127.0.0.1:6081", ws: true });
const meta = mode === "fixture" ? createMessengerFixture(store) : createMetaClient({ pageAccessToken: metaConfig.pageAccessToken, graphVersion: process.env.META_GRAPH_VERSION });
const messengerWorker = createMessengerWorker({ store, generate: messengerGenerator, decide: decideReplyAction, meta });

proxy.on("open", (socket) => {
  desktopSockets.add(socket);
  socket.on("close", () => desktopSockets.delete(socket));
});
proxy.on("error", (_error, _req, response) => {
  if (response?.writeHead) {
    response.writeHead(502, { "Content-Type": "text/plain" });
    response.end("Remote browser is starting. Reload this panel in a moment.");
  }
});

app.get("/webhooks/meta", (request, response) => {
  const challenge = verifyChallenge(request.query, metaConfig.verifyToken);
  if (challenge === null) return response.status(403).send("Verification failed");
  response.type("text/plain").send(challenge);
});
app.post("/webhooks/meta", express.raw({ type: "application/json", limit: "256kb" }), (request, response) => {
  if (!verifySignature(request.body, request.get("x-hub-signature-256"), metaConfig.appSecret)) return response.status(401).json({ error: "Invalid webhook signature." });
  let payload;
  try { payload = JSON.parse(request.body.toString("utf8")); } catch { return response.status(400).json({ error: "Invalid JSON." }); }
  const events = normalizePageEvents(payload, metaConfig.pageId);
  response.status(200).send("EVENT_RECEIVED");
  void messengerWorker.enqueue(events).then(() => messengerWorker.drain()).catch(() => undefined);
});

app.use(express.json({ limit: "32kb" }));
app.use("/fixture/assets", express.static(path.join(root, "fixture"), { index: false }));

app.get("/health", (_request, response) => response.json({ ok: true, mode }));

app.get("/novnc/package.json", (_request, response) => response.json({ name: "novnc", version: "system" }));
app.use("/novnc", (request, response) => {
  if (browserBusy) return response.status(423).send("Automation is using the browser. Try again when the operation finishes.");
  request.url = request.originalUrl.replace(/^\/novnc/, "") || "/";
  proxy.web(request, response);
});

app.get("/api/state", (_request, response) => {
  response.json(publicState(store.read(), runtime()));
});

app.get("/api/groups", (_request, response) => {
  response.json({ groups: Object.values(store.read().groups) });
});

app.post("/api/groups", asyncRoute(async (request, response) => {
  const group = await groups.add(requiredText(request.body?.url, "Group URL"));
  response.json(group);
}));

app.patch("/api/groups/:groupId", asyncRoute(async (request, response) => {
  if (typeof request.body?.enabled !== "boolean") throw httpError(400, "Enabled must be true or false.");
  response.json(await groups.setEnabled(request.params.groupId, request.body.enabled));
}));

app.post("/api/groups/scan-all", asyncRoute(async (_request, response) => {
  response.json(await groups.scanAll());
}));

app.post("/api/groups/:groupId/scan", asyncRoute(async (request, response) => {
  response.json(await groups.scanOne(request.params.groupId));
}));

app.get("/api/business-profile", (_request, response) => {
  response.json(store.read().businessProfile);
});

app.put("/api/business-profile", asyncRoute(async (request, response) => {
  const description = requiredText(request.body?.description, "Business description");
  const relevanceThreshold = Number(request.body?.relevanceThreshold);
  if (!Number.isInteger(relevanceThreshold) || relevanceThreshold < 0 || relevanceThreshold > 100) {
    throw httpError(400, "Relevance threshold must be an integer from 0 to 100.");
  }
  const profile = await store.mutate((state) => {
    state.businessProfile.description = description;
    state.businessProfile.relevanceThreshold = relevanceThreshold;
    state.businessProfile.updatedAt = new Date().toISOString();
    return state.businessProfile;
  });
  response.json(profile);
}));

app.post("/api/targets/:targetKey/analyze", asyncRoute(async (request, response) => {
  const targetKey = request.params.targetKey;
  if (!store.read().targets[targetKey]) throw httpError(404, "Target not found.");
  const result = await groups.analyzePending([targetKey]);
  response.json(result.analyses[0] ?? store.read().analyses[targetKey]);
}));

app.post("/api/analyze-pending", asyncRoute(async (_request, response) => {
  response.json(await groups.analyzePending());
}));

app.get("/api/messenger/status", (_request, response) => {
  const state = store.read();
  response.json({ configured: runtime().messengerConfigured, enabled: state.messengerConfig.enabled, pageName: state.messengerConfig.pageName, lastWebhookAt: state.messengerConfig.lastWebhookAt, lastSendAt: state.messengerConfig.lastSendAt, missing: runtime().messengerConfigured ? [] : ["META_PAGE_ID", "META_PAGE_ACCESS_TOKEN", "META_APP_SECRET", "META_VERIFY_TOKEN"].filter((name) => !process.env[name]) });
});
app.post("/api/messenger/enable", asyncRoute(async (_request, response) => {
  if (!runtime().messengerConfigured) throw httpError(409, "Complete all Meta Page credentials before enabling auto-reply.");
  response.json(await store.mutate((state) => { state.messengerConfig.pageId = metaConfig.pageId; state.messengerConfig.pageName ??= mode === "fixture" ? "Rental Radar Test Page" : "Facebook Page"; state.messengerConfig.enabled = true; return state.messengerConfig; }));
}));
app.post("/api/messenger/disable", asyncRoute(async (_request, response) => response.json(await store.mutate((state) => { state.messengerConfig.enabled = false; return state.messengerConfig; }))));
app.get("/api/messenger/threads", (_request, response) => {
  const state = store.read();
  const threads = Object.values(state.messengerThreads).map((thread) => ({ ...thread, messages: Object.values(state.messengerMessages).filter((message) => message.senderId === thread.id), outbound: Object.values(state.messengerOutbound).filter((message) => message.senderId === thread.id) }));
  response.json({ threads });
});
app.patch("/api/messenger/threads/:senderId", asyncRoute(async (request, response) => response.json(await messengerWorker.setThreadStatus(request.params.senderId, request.body?.status))));
app.get("/api/reply-profile", (_request, response) => response.json(store.read().replyProfile));
app.put("/api/reply-profile", asyncRoute(async (request, response) => {
  const profile = validateReplyProfile(request.body);
  response.json(await store.mutate((state) => { state.replyProfile = { ...state.replyProfile, ...profile, updatedAt: new Date().toISOString() }; return state.replyProfile; }));
}));
app.post("/api/reply-profile/preview", asyncRoute(async (request, response) => {
  const profile = validateReplyProfile(request.body?.profile ?? store.read().replyProfile);
  response.json({ text: renderReplyProfile(profile, { customer_name: "คุณเมย์", business_name: store.read().businessProfile.name, location: "อ่อนนุช", budget: "12,000 บาท" }, request.body?.body || "ขอบคุณที่สนใจค่ะ รบกวนแจ้งวันที่ต้องการย้ายเข้าเพิ่มเติมได้ไหมคะ"), sent: false });
}));

app.post("/api/session/check", asyncRoute(async (_request, response) => {
  const state = store.read();
  const groupUrl = state.config.groupUrl ?? defaultGroupUrl();
  const session = await withBrowserLease(() => site.inspectSession(groupUrl));
  await record("session_checked", session.state);
  response.json(session);
}));

app.post("/api/group", asyncRoute(async (request, response) => {
  const groupUrl = site.normalizeGroupUrl(requiredText(request.body?.url, "Group URL"));
  await store.mutate((state) => {
    if (state.config.groupUrl && state.config.groupUrl !== groupUrl) {
      throw httpError(409, "This POC is already bound to one group. Reset the state volume to change it.");
    }
    state.config.groupUrl = groupUrl;
    addEvent(state, "group_bound", groupUrl);
    return state.config;
  });
  response.json({ groupUrl });
}));

app.post("/api/scan", asyncRoute(async (_request, response) => {
  const before = store.read();
  if (!before.config.groupUrl) throw httpError(400, "Bind one group before scanning.");
  const session = await withBrowserLease(() => site.inspectSession(before.config.groupUrl));
  if (session.state !== "connected") throw httpError(409, "Use the browser panel to sign in before scanning.");
  const scan = await withBrowserLease(() => site.scan(before.config.groupUrl));
  const result = await store.mutate((state) => {
    state.config.groupId = scan.groupId;
    state.config.groupName = scan.groupName;
    const stableTargets = preserveSubmittedTargetKeys(scan.targets, state.targets, state.submissions);
    const scannedKeys = new Set(stableTargets.map((target) => target.key));
    for (const [key, target] of Object.entries(state.targets)) {
      if (target.groupId === scan.groupId && !scannedKeys.has(key) && !state.submissions[key]) delete state.targets[key];
    }
    for (const target of stableTargets) state.targets[target.key] = target;
    addEvent(state, "scan_finished", `${stableTargets.length} targets`);
    return { count: stableTargets.length, targets: stableTargets };
  });
  response.json(result);
}));

app.post("/api/drafts", asyncRoute(async (request, response) => {
  const targetKey = requiredText(request.body?.targetKey, "Target key");
  const target = store.read().targets[targetKey];
  if (!target) throw httpError(404, "Target not found. Scan again.");
  const proposal = await generateText(target);
  const draft = await store.mutate((state) => {
    const value = {
      id: id("draft"),
      targetKey,
      revision: 1,
      text: proposal.text,
      source: proposal.source,
      detail: proposal.detail,
      updatedAt: new Date().toISOString(),
    };
    state.drafts[value.id] = value;
    addEvent(state, "draft_generated", `${proposal.source} for ${targetKey}`);
    return value;
  });
  response.json(draft);
}));

app.patch("/api/drafts/:id", asyncRoute(async (request, response) => {
  const text = validReply(request.body?.text);
  const expectedRevision = Number(request.body?.revision);
  const draft = await store.mutate((state) => {
    const current = state.drafts[request.params.id];
    if (!current) throw httpError(404, "Draft not found.");
    if (current.revision !== expectedRevision) throw httpError(409, "This draft changed in another tab. Reload it.");
    current.text = text;
    current.revision += 1;
    current.updatedAt = new Date().toISOString();
    for (const [key, review] of Object.entries(state.reviews)) {
      if (review.draftId === current.id) delete state.reviews[key];
    }
    addEvent(state, "draft_edited", current.id);
    return current;
  });
  response.json(draft);
}));

app.post("/api/drafts/:id/review", asyncRoute(async (request, response) => {
  const expectedRevision = Number(request.body?.revision);
  const token = crypto.randomUUID();
  const review = await store.mutate((state) => {
    const draft = state.drafts[request.params.id];
    if (!draft) throw httpError(404, "Draft not found.");
    if (draft.revision !== expectedRevision) throw httpError(409, "Save the latest draft before review.");
    const target = state.targets[draft.targetKey];
    const value = {
      draftId: draft.id,
      draftRevision: draft.revision,
      targetKey: target.key,
      target: { kind: target.kind, author: target.author, text: target.text, url: target.url },
      exactText: draft.text,
      expiresAt: Date.now() + 5 * 60 * 1000,
    };
    state.reviews[digest(token)] = value;
    addEvent(state, "review_created", target.key);
    return value;
  });
  response.json({ token, ...review });
}));

app.post("/api/submit", asyncRoute(async (request, response) => {
  if (request.body?.confirmed !== true) throw httpError(400, "Explicit confirmation is required.");
  if (mode === "live" && !liveSubmissionEnabled) {
    throw httpError(403, "Live submission is disabled. Enable it only for an authorized test target.");
  }
  const token = requiredText(request.body?.token, "Review token");
  const reviewKey = digest(token);
  const snapshot = store.read();
  const review = snapshot.reviews[reviewKey];
  if (!review) throw httpError(404, "Review expired, was edited, or was already consumed.");
  if (review.expiresAt < Date.now()) throw httpError(410, "Review expired. Open a fresh review.");
  const existing = snapshot.submissions[review.targetKey];
  if (existing) return response.json(existing);
  const target = snapshot.targets[review.targetKey];
  const draft = snapshot.drafts[review.draftId];
  if (!draft || draft.revision !== review.draftRevision || draft.text !== review.exactText) {
    throw httpError(409, "The draft changed after review.");
  }

  updateBrowserOperation({ status: "running", phase: "preparing_reply", groupId: target.groupId, groupName: snapshot.groups[target.groupId]?.name, groupUrl: snapshot.groups[target.groupId]?.url, current: 1, total: 1, detail: `Locating ${target.kind} by ${target.author || "Facebook member"}` });
  const submission = await withBrowserLease(async () => {
    await site.preflight(target);
    updateBrowserOperation({ status: "running", phase: "sending_reply", detail: `Sending the reviewed reply to ${target.author || "Facebook member"}` });
    const reservation = await store.mutate((state) => {
      if (state.submissions[target.key]) return { created: false, value: state.submissions[target.key] };
      const value = {
        id: id("attempt"),
        targetKey: target.key,
        draftId: draft.id,
        exactText: review.exactText,
        state: "attempted",
        createdAt: new Date().toISOString(),
        detail: "The target is durably reserved before the remote click.",
      };
      state.submissions[target.key] = value;
      delete state.reviews[reviewKey];
      addEvent(state, "submission_reserved", target.key);
      return { created: true, value };
    });
    if (!reservation.created) return reservation.value;

    try {
      const evidence = await site.submitOnce(target, review.exactText, reservation.value.id);
      updateBrowserOperation({ status: evidence.verified ? "completed" : "failed", phase: evidence.verified ? "reply_verified" : "reply_unverified", detail: evidence.detail ?? "Reply attempt finished" });
      return store.mutate((state) => {
        const current = state.submissions[target.key];
        current.state = evidence.verified ? "verified" : "unknown";
        current.evidenceId = evidence.screenshotId;
        current.detail = evidence.detail ?? "The exact reply is visible under the selected fixture target.";
        current.finishedAt = new Date().toISOString();
        addEvent(state, `submission_${current.state}`, target.key);
        return current;
      });
    } catch (error) {
      updateBrowserOperation({ status: "failed", phase: "reply_failed", detail: safeMessage(error) });
      return store.mutate((state) => {
        const current = state.submissions[target.key];
        current.state = "unknown";
        current.detail = safeMessage(error);
        current.finishedAt = new Date().toISOString();
        addEvent(state, "submission_unknown", target.key);
        return current;
      });
    }
  });
  response.json(submission);
}));

app.post("/api/submissions/:targetKey/reconcile", asyncRoute(async (request, response) => {
  const snapshot = store.read();
  const submission = snapshot.submissions[request.params.targetKey];
  if (!submission) throw httpError(404, "Submission not found.");
  if (submission.state === "verified") {
    if (mode === "live" && submission.detail.includes("fixture")) {
      const corrected = await store.mutate((state) => {
        const current = state.submissions[submission.targetKey];
        current.detail = "Read-only reconciliation found the exact reply beneath the selected live target.";
        return current;
      });
      return response.json(corrected);
    }
    return response.json(submission);
  }
  const target = snapshot.targets[submission.targetKey];
  const evidence = await withBrowserLease(() => site.reconcile(target, submission.exactText, submission.id));
  if (!evidence.verified) return response.json(submission);
  const reconciled = await store.mutate((state) => {
    const current = state.submissions[submission.targetKey];
    current.state = "verified";
    current.evidenceId = evidence.screenshotId;
    current.detail = mode === "fixture"
      ? "Read-only reconciliation found the exact fixture reply."
      : "Read-only reconciliation found the exact reply beneath the selected live target.";
    addEvent(state, "submission_reconciled", submission.targetKey);
    return current;
  });
  response.json(reconciled);
}));

app.get("/api/evidence/:id", (request, response, next) => {
  try {
    const file = store.evidencePath(request.params.id);
    if (!fs.existsSync(file)) throw httpError(404, "Evidence not found.");
    response.sendFile(file);
  } catch (error) {
    next(error);
  }
});

app.get("/fixture/login", (_request, response) => response.send(fixtureLogin()));
app.post("/fixture/login", (_request, response) => {
  response.setHeader("Set-Cookie", "fixture_session=connected; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000");
  response.redirect("/fixture/groups/1001");
});
app.get("/fixture/groups/:groupId", (request, response) => {
  if (!["1001", "1002"].includes(request.params.groupId)) return response.status(404).send("Fixture group not found.");
  if (!hasFixtureSession(request)) return response.redirect("/fixture/login");
  response.send(fixtureGroup(request.params.groupId, store.read().fixtureReplies));
});
app.post("/fixture/api/replies", asyncRoute(async (request, response) => {
  if (!hasFixtureSession(request)) throw httpError(401, "Fixture session expired.");
  const targetKey = requiredText(request.body?.targetKey, "Target key");
  const text = validReply(request.body?.text);
  const allowed = /^fixture:(1001|1002):p[12]:(post|c[1-3])$/.test(targetKey);
  if (!allowed) throw httpError(400, "Unknown fixture target.");
  const reply = await store.mutate((state) => {
    const value = { id: id("reply"), targetKey, text, author: "Fixture Admin", createdAt: new Date().toISOString() };
    state.fixtureReplies.push(value);
    return value;
  });
  response.json(reply);
}));
app.get("/fixture/api/state", (_request, response) => response.json({ replies: store.read().fixtureReplies }));
app.get("/fixture/api/messenger/sends", (_request, response) => response.json({ sends: store.read().fixtureMessengerSends ?? [] }));
app.post("/fixture/api/messenger/sample", asyncRoute(async (request, response) => {
  if (mode !== "fixture") throw httpError(404, "Not found.");
  const mid = request.body?.mid || `mid.${Date.now()}`;
  const events = normalizePageEvents({ object: "page", entry: [{ id: metaConfig.pageId, messaging: [{ sender: { id: request.body?.senderId || "customer-1001" }, recipient: { id: metaConfig.pageId }, timestamp: Date.now(), message: { mid, text: request.body?.text || "หาคอนโดใกล้ BTS อ่อนนุช งบ 15,000 บาท" } }] }] }, metaConfig.pageId);
  const accepted = await messengerWorker.enqueue(events);
  await messengerWorker.drain();
  response.json({ ...accepted, mid, sends: store.read().fixtureMessengerSends.length });
}));

app.use((request, response, nextError) => {
  nextHandler(request, response).catch(nextError);
});

app.use((error, _request, response, _next) => {
  const status = Number(error?.status) || 500;
  response.status(status).json({ error: safeMessage(error) });
});

server.on("upgrade", (request, socket, head) => {
  if (!request.url?.startsWith("/novnc/")) return socket.destroy();
  if (browserBusy) return socket.destroy();
  request.url = request.url.replace(/^\/novnc/, "");
  proxy.ws(request, socket, head);
});

server.listen(port, "0.0.0.0", () => {
  console.log(`POC dashboard listening on http://0.0.0.0:${port} in ${mode} mode`);
  void messengerWorker.recover().catch(() => undefined);
});

function runtime() {
  return {
    mode,
    liveSubmissionEnabled,
    openAIConfigured: Boolean(process.env.OPENAI_API_KEY),
    model,
    browserBusy,
    browserOperation,
    messengerConfigured: Boolean(metaConfig.pageId && metaConfig.pageAccessToken && metaConfig.appSecret && metaConfig.verifyToken),
  };
}

function updateBrowserOperation(next) {
  const startedAt = next.status === "running" && browserOperation.status !== "running"
    ? new Date().toISOString()
    : browserOperation.startedAt;
  browserOperation = {
    ...browserOperation,
    ...next,
    startedAt,
    updatedAt: new Date().toISOString(),
    finishedAt: next.status === "completed" || next.status === "failed" ? new Date().toISOString() : null,
  };
}

async function withBrowserLease(operation) {
  if (browserBusy) throw httpError(423, "The browser is busy with another operation.");
  browserBusy = true;
  for (const socket of desktopSockets) socket.destroy();
  desktopSockets.clear();
  try {
    return await operation();
  } finally {
    browserBusy = false;
  }
}

function asyncRoute(handler) {
  return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}

function requiredText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw httpError(400, `${label} is required.`);
  return value.trim();
}

function validReply(value) {
  const text = requiredText(value, "Reply").replace(/\r\n/g, "\n");
  if (text.length > 2000) throw httpError(400, "Reply must be 2,000 characters or fewer.");
  return text;
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function safeMessage(error) {
  return (error instanceof Error ? error.message : "Unexpected error")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")
    .slice(0, 240);
}

function addEvent(state, action, detail) {
  state.events.push({ id: id("event"), action, detail, at: new Date().toISOString() });
}

async function record(action, detail) {
  await store.mutate((state) => addEvent(state, action, detail));
}

function defaultGroupUrl() {
  return mode === "fixture" ? "http://127.0.0.1:3000/fixture/groups/1001" : "https://www.facebook.com/";
}

function hasFixtureSession(request) {
  return request.headers.cookie?.split(";").some((value) => value.trim() === "fixture_session=connected") ?? false;
}

function fixtureLogin() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/fixture/assets/fixture.css"><title>Fixture login</title></head><body class="fixture-shell"><main class="login-card"><span class="fixture-mark">f</span><h1>Facebook fixture</h1><p>This page simulates manual authentication. The cookie lives in the persistent Chromium profile.</p><form method="post" action="/fixture/login"><button type="submit">Continue as Fixture Admin</button></form></main></body></html>`;
}

function fixtureGroup(groupId, replies) {
  const ownReplies = (targetKey) => replies.filter((reply) => reply.targetKey === targetKey).map((reply) => `<div class="own-reply" data-poc-own-reply data-poc-target-key="${escapeHtml(reply.targetKey)}"><b>${escapeHtml(reply.author)}</b><span>${escapeHtml(reply.text)}</span></div>`).join("");
  const comment = (postId, commentId, author, text) => {
    const key = `fixture:${groupId}:${postId}:${commentId}`;
    return `<div class="comment" data-poc-comment-id="${commentId}"><b data-poc-author>${escapeHtml(author)}</b><p data-poc-comment-text>${escapeHtml(text)}</p><div class="replies">${ownReplies(key)}</div><div class="composer"><textarea data-poc-composer="comment" aria-label="Reply to ${escapeHtml(author)}"></textarea><button data-poc-submit="comment" data-target-key="${key}">Reply</button></div></div>`;
  };
  const post = (postId, author, text, comments) => {
    const key = `fixture:${groupId}:${postId}:post`;
    return `<article data-poc-post-id="${postId}"><header><div class="avatar">${escapeHtml(author[0])}</div><div><b data-poc-author>${escapeHtml(author)}</b><small>Just now · Test fixture</small></div></header><p class="post-text" data-poc-post-text>${escapeHtml(text)}</p><div class="replies">${ownReplies(key)}</div><section class="comments">${comments}</section><div class="composer"><textarea data-poc-composer="post" aria-label="Write a comment"></textarea><button data-poc-submit="post" data-target-key="${key}">Comment</button></div></article>`;
  };
  const ownerGroup = groupId === "1002";
  const title = ownerGroup ? "Bangkok Condo Owners Test Group" : "Bangkok Room Finder Test Group";
  const posts = ownerGroup
    ? post("p1", "Narin", "เจ้าของห้องต้องการเอเจนต์ช่วยปล่อยเช่าคอนโด Ideo สุขุมวิท", comment("p1", "c1", "Pim", "มีรูปและรายละเอียดพร้อมค่ะ")) + post("p2", "Jane", "ปล่อยเช่าคอนโด 1 ห้องนอน 17,000 บาท ใกล้ BTS พระโขนง", comment("p2", "c3", "May", "ห้องว่างเดือนหน้าค่ะ"))
    : post("p1", "Mali", "หาห้องเช่าใกล้ BTS อ่อนนุช งบไม่เกิน 12,000 บาท ย้ายต้นเดือนหน้า", comment("p1", "c1", "Nok", "สนใจโซนอ่อนนุชเหมือนกันค่ะ") + comment("p1", "c2", "Ton", "มีห้องใกล้สถานีประมาณ 500 เมตรครับ")) + post("p2", "Beam", "Looking for a studio near Ari. Budget 18,000 THB and pet friendly.", comment("p2", "c3", "May", "I know one building near Soi Ari 2."));
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/fixture/assets/fixture.css"><title>${title}</title></head><body><nav><span class="fixture-mark">f</span><b>Facebook fixture</b><span>Fixture Admin</span></nav><main class="feed" data-poc-group-id="${groupId}"><section class="group-head"><small>Private group · fixture</small><h1>${title}</h1><p>Stable local content for repeatable browser automation.</p></section>${posts}</main><script>document.addEventListener("click",async(event)=>{const button=event.target.closest("button[data-target-key]");if(!button)return;const box=button.parentElement.querySelector("textarea");const text=box.value.trim();if(!text)return;button.disabled=true;const result=await fetch("/fixture/api/replies",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({targetKey:button.dataset.targetKey,text})});if(result.ok)location.reload();else{button.disabled=false;alert("Fixture submission failed");}});</script></body></html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

