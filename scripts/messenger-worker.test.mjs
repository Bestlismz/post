import assert from "node:assert/strict"; import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import test from "node:test";
import { createMessengerWorker } from "../src/messenger-worker.mjs"; import { createStore } from "../src/state.mjs";
import { createMessengerGenerator } from "../src/messenger-generator.mjs";
import { decideReplyAction } from "../src/reply-policy.mjs";
test("real generator fallback is routed to review before a legacy clarify or reply can send", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-fallback-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createStore(dir);
  await store.mutate(state => { state.messengerConfig.enabled = true; });
  let sends = 0;
  const generate = createMessengerGenerator({ client: { responses: { create: async () => { throw new Error("unavailable"); } } } });
  const worker = createMessengerWorker({ store, generate, decide: decideReplyAction, meta: { sendText: async () => { sends++; return { state: "sent" }; } } });
  await worker.enqueue([{ key: "fallback", mid: "m-fallback", senderId: "u", timestamp: Date.now(), text: "Looking to rent a condo near Asoke, max budget 18000", attachments: [] }]);
  await worker.drain();
  assert.equal(sends, 0);
  assert.equal(store.read().messengerMessages.fallback.state, "review");
  assert.equal(Object.keys(store.read().messengerOutbound).length, 0);
});
test("deduplicates a mid and sends once",async()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),"worker-"));const store=createStore(dir);await store.mutate(s=>{s.messengerConfig.enabled=true});let sends=0;const worker=createMessengerWorker({store,generate:async()=>({text:"reply",automaticEligible:true,analysis:{score:90}}),decide:()=>({action:"reply"}),meta:{sendText:async()=>{sends++;return{state:"sent",messageId:"out"}}}});const event={key:"p:m",mid:"m",senderId:"u",timestamp:Date.now(),text:"hello",attachments:[]};await worker.enqueue([event,event]);await worker.drain();assert.equal(sends,1);assert.equal(Object.keys(store.read().messengerMessages).length,1)});
