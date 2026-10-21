import { id } from "./state.mjs";

export function createMessengerWorker({ store, generate, decide, meta, now = () => Date.now() }) {
  let draining = null;
  async function enqueue(events) {
    return store.mutate((state) => {
      let accepted = 0;
      for (const event of events) {
        if (state.messengerMessages[event.key]) continue;
        state.messengerMessages[event.key] = { ...event, state: "queued", receivedAt: new Date(now()).toISOString() };
        state.messengerThreads[event.senderId] ??= { id: event.senderId, customerName: "Facebook customer", status: "bot_active", lastMessageAt: null, insight: null };
        state.messengerThreads[event.senderId].lastMessageAt = new Date(event.timestamp).toISOString();
        accepted += 1;
      }
      if (accepted) state.messengerConfig.lastWebhookAt = new Date(now()).toISOString();
      return { accepted };
    });
  }
  async function processOne(key) {
    const snapshot = store.read(), event = snapshot.messengerMessages[key], thread = snapshot.messengerThreads[event.senderId];
    if (!event || event.state !== "queued") return;
    await store.mutate((state) => { state.messengerMessages[key].state = "analyzing"; });
    const generated = await generate(event, thread, snapshot.businessProfile, snapshot.replyProfile);
    const current = store.read();
    const decision = decide({ event, thread: current.messengerThreads[event.senderId], analysis: generated.analysis, config: { ...current.messengerConfig, handoffKeywords: current.replyProfile.humanHandoffKeywords }, now: now() });
    if (decision.action === "ignore") return store.mutate((state) => { state.messengerMessages[key].state = "ignored"; state.messengerMessages[key].detail = decision.reason; });
    if (decision.action === "acknowledge_and_handoff") await store.mutate((state) => { state.messengerThreads[event.senderId].status = "human_handoff"; });
    const reservation = await store.mutate((state) => {
      if (state.messengerOutbound[key]) return { created: false };
      state.messengerOutbound[key] = { id: id("msg"), replyToMid: event.mid, senderId: event.senderId, text: generated.text, state: "reserved", createdAt: new Date(now()).toISOString() };
      state.messengerThreads[event.senderId].insight = generated.analysis;
      return { created: true };
    });
    if (!reservation.created) return;
    const beforeSend = store.read();
    if (beforeSend.messengerThreads[event.senderId].status === "paused") return store.mutate((state) => { state.messengerOutbound[key].state = "suppressed"; state.messengerMessages[key].state = "ignored"; });
    if (beforeSend.messengerThreads[event.senderId].status === "human_handoff" && decision.action !== "acknowledge_and_handoff") return store.mutate((state) => { state.messengerOutbound[key].state = "suppressed"; state.messengerMessages[key].state = "handoff"; });
    const result = await meta.sendText({ recipientId: event.senderId, text: generated.text, metadata: `reply:${event.mid}` });
    await store.mutate((state) => { const out = state.messengerOutbound[key]; out.state = result.state; out.messageId = result.messageId ?? null; out.detail = result.detail ?? null; out.finishedAt = new Date(now()).toISOString(); state.messengerMessages[key].state = result.state === "sent" ? "sent" : result.state === "rejected" ? "failed" : "unknown"; state.messengerConfig.lastSendAt = out.finishedAt; });
  }
  async function drain() {
    if (draining) return draining;
    draining = (async () => { for (const [key, message] of Object.entries(store.read().messengerMessages)) if (message.state === "queued") await processOne(key); })().finally(() => { draining = null; });
    return draining;
  }
  async function recover() { await store.mutate((state) => { for (const message of Object.values(state.messengerMessages)) if (message.state === "analyzing") message.state = "queued"; }); return drain(); }
  async function setThreadStatus(senderId, status) { if (!new Set(["bot_active", "paused", "human_handoff"]).has(status)) throw new Error("Invalid thread status"); return store.mutate((state) => { if (!state.messengerThreads[senderId]) throw new Error("Thread not found"); state.messengerThreads[senderId].status = status; return state.messengerThreads[senderId]; }); }
  return { enqueue, drain, recover, setThreadStatus };
}
