"use client";

import { useEffect, useState } from "react";
import { Intent, StatusDot, SurfaceHead } from "./ui";

export function MessengerInbox({ workspace, request, busy, setNotice, onSettings, onLoadDemo }) {
  const [threads, setThreads] = useState([]);
  const [selected, setSelected] = useState(null);

  async function load() {
    const response = await fetch("/api/messenger/threads", { cache: "no-store" });
    const data = await response.json();
    setThreads(data.threads || []);
    setSelected((current) => data.threads.find((item) => item.id === current?.id) || data.threads[0] || null);
  }

  useEffect(() => { load(); }, [workspace.messengerMessages?.length]);

  async function updateStatus(value) {
    await request("Updating conversation", `/api/messenger/threads/${selected.id}`, { method: "PATCH", body: JSON.stringify({ status: value }) });
    await load();
    setNotice({ type: "success", text: value === "human_handoff" ? "Bot paused. A human now owns this conversation." : "Conversation mode updated." });
  }

  async function sample() {
    await request("Receiving sample message", "/fixture/api/messenger/sample", { method: "POST", body: JSON.stringify({ text: "หาคอนโดใกล้ BTS อ่อนนุช งบ 15,000 บาท ย้ายเดือนหน้า" }) });
    await load();
  }

  return <section className="inbox-grid enter">
    <aside className="surface inbox-queue">
      <SurfaceHead title="Page Inbox" subtitle={`${threads.length} conversations${threads.some((thread) => thread.demo) ? " · demo ready" : ""}`} action={<StatusDot state={workspace.messenger.enabled ? "live" : "muted"} />} />
      {workspace.mode === "fixture" ? <button className="sample-message" onClick={sample} disabled={!!busy}><span aria-hidden="true">+</span> Simulate inquiry</button> : null}
      <div className="thread-list">{threads.map((thread) => {
        const active = thread.status === "bot_active";
        return <button className={selected?.id === thread.id ? "selected" : ""} key={thread.id} onClick={() => setSelected(thread)} aria-label={`${thread.customerName}, ${active ? "bot active" : "human handoff"}`}>
          <i className="thread-avatar">{thread.customerName?.[0] || "F"}</i>
          <span><b>{thread.customerName}</b><small>{thread.messages.at(-1)?.text || "Attachment"}</small><em>{new Date(thread.lastMessageAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</em></span>
          <span className={`thread-state ${active ? "bot" : "human"}`}>{thread.demo ? `DEMO · ${active ? "BOT" : "HUMAN"}` : active ? "BOT" : "HUMAN"}</span>
        </button>;
      })}{!threads.length ? <div className="empty">No Page messages yet.<button onClick={onLoadDemo} disabled={!!busy}>Load customer demo</button></div> : null}</div>
    </aside>
    <article className="surface conversation">{selected ? <>
      <SurfaceHead title={selected.customerName} subtitle={selected.status === "bot_active" ? "Bot is handling this conversation" : "Human handoff · bot paused"} action={<button onClick={() => updateStatus(selected.status === "bot_active" ? "human_handoff" : "bot_active")} disabled={!!busy}>{selected.status === "bot_active" ? "Take over" : "Resume bot"}</button>} />
      <div className="message-stream"><div className="conversation-date">Today</div>{selected.messages.map((message) => <div className="bubble inbound" key={message.key}><p>{message.text || "Sent an attachment"}</p><small>{new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small></div>)}{selected.outbound.map((message) => <div className={`bubble outbound ${message.state}`} key={message.id}><p>{message.text}</p><small>Bot · {message.state}</small></div>)}</div>
      {selected.status === "human_handoff" ? <div className="manual-compose"><textarea aria-label="Manual Page reply" placeholder="Write a manual Page reply…" /><button disabled title="Manual Send API compose is outside this POC">Send manually</button></div> : null}
    </> : <div className="empty">Select a conversation or simulate an inquiry.</div>}</article>
    <aside className="surface insight">
      <SurfaceHead title="Lead insight" subtitle="AI qualification" />
      {selected?.insight ? <div className="insight-body"><div className="insight-score"><b>{selected.insight.score}</b><span>match score</span></div><Intent value={selected.insight.intent} /><dl><dt>Location</dt><dd>{selected.insight.extracted?.location || "Not provided"}</dd><dt>Budget</dt><dd>{selected.insight.extracted?.budget || "Not provided"}</dd><dt>Move date</dt><dd>{selected.insight.extracted?.moveDate || "Not provided"}</dd></dl><div className="missing-fields"><small>Still needed</small><b>{selected.insight.missing?.join(", ").replaceAll("_", " ") || "All key details captured"}</b></div></div> : <div className="empty">Lead details appear after analysis.</div>}
      <button className="settings-link" onClick={onSettings}>Reply format settings →</button>
    </aside>
  </section>;
}
