"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { api } from "../lib/api-client.mjs";
import { ConversationPane } from "./conversation-pane";
import { InboxQueue } from "./inbox-queue";
import { LeadInspector } from "./lead-inspector";
import { ReplyComposer } from "./reply-composer";
import "./workspace.css";

const idempotencyKey = (action, id) => `${action}-${id}-${crypto.randomUUID()}`;
function commandHeaders({ action, id, revision, csrfToken }) {
  const headers = { "Idempotency-Key": idempotencyKey(action, id), "If-Match": `"${revision}"` };
  if (csrfToken) headers["X-CSRF-Token"] = csrfToken;
  return headers;
}

function InboxWorkspace() {
  const router = useRouter(), searchParams = useSearchParams(), requestedId = searchParams.get("item");
  const [items, setItems] = useState([]), [listState, setListState] = useState({ loading: true, error: null });
  const [selectedId, setSelectedId] = useState(requestedId), [detail, setDetail] = useState(null);
  const [detailState, setDetailState] = useState({ loading: false, error: null });
  const [inspectorOpen, setInspectorOpen] = useState(true), [receipt, setReceipt] = useState(null), [csrfToken, setCsrfToken] = useState("");
  const selectedRef = useRef(selectedId); selectedRef.current = selectedId;
  const detailRef = useRef(detail); detailRef.current = detail;

  const loadList = useCallback(async () => {
    setListState({ loading: true, error: null });
    try {
      const payload = await api.request("/api/inbox"), nextItems = Array.isArray(payload?.items) ? payload.items : [];
      setItems(nextItems);
      setSelectedId((current) => current && nextItems.some((item) => item.id === current) ? current : nextItems[0]?.id ?? null);
      setListState({ loading: false, error: null });
    } catch (error) { setListState({ loading: false, error }); }
  }, []);

  const loadDetail = useCallback(async (id) => {
    if (!id) { setDetail(null); return; }
    setDetailState({ loading: true, error: null });
    try {
      const payload = await api.request(`/api/inbox/${encodeURIComponent(id)}`);
      if (selectedRef.current === id) { setDetail(payload); setDetailState({ loading: false, error: null }); }
    } catch (error) { if (selectedRef.current === id) setDetailState({ loading: false, error }); }
  }, []);

  useEffect(() => { void loadList(); void api.request("/api/auth/csrf", { method: "POST" }).then((value) => setCsrfToken(value?.csrfToken ?? "")).catch(() => undefined); }, [loadList]);
  useEffect(() => { if (requestedId) setSelectedId(requestedId); }, [requestedId]);
  useEffect(() => { setDetail(null); void loadDetail(selectedId); }, [selectedId, loadDetail]);
  useEffect(() => {
    if (typeof EventSource === "undefined") return undefined;
    const events = new EventSource("/api/inbox/events");
    const handleReceipt = (event) => {
      try {
        const next = JSON.parse(event.data); setReceipt(next);
        const current = detailRef.current;
        const resources = [selectedRef.current, current?.conversationId, ...(current?.replies ?? []).map((reply) => reply.id), ...(current?.deliveries ?? []).map((delivery) => delivery.id)];
        if (next.resourceType === "inbox" || resources.includes(next.resourceId)) void loadDetail(selectedRef.current);
      } catch { /* a later durable receipt reconciles malformed transport data */ }
    };
    events.addEventListener("inbox", handleReceipt);
    events.addEventListener("reset", () => { void loadList(); void loadDetail(selectedRef.current); });
    return () => events.close();
  }, [loadDetail, loadList]);

  const selectedSummary = useMemo(() => items.find((item) => item.id === selectedId) ?? null, [items, selectedId]);
  const choose = useCallback((id) => {
    setSelectedId(id); const params = new URLSearchParams(searchParams.toString()); params.set("item", id);
    router.replace(`/inbox?${params.toString()}`, { scroll: false });
  }, [router, searchParams]);

  const runCommand = useCallback(async (action, input = {}) => {
    if (!detail) return null;
    const revision = detail.processingRevision;
    if (action === "prepare") return api.request(`/api/inbox/${encodeURIComponent(detail.id)}/prepare`, { method: "POST", headers: commandHeaders({ action, id: detail.id, revision, csrfToken }), body: "{}" });
    if (action === "handoff") return api.request(`/api/inbox/${encodeURIComponent(detail.id)}/handoff`, { method: "POST", headers: commandHeaders({ action, id: detail.id, revision, csrfToken }), body: JSON.stringify({ reason: input.reason ?? "ส่งต่อให้ทีมดูแลจาก Inbox" }) });
    if (action === "edit") return api.request(`/api/replies/${encodeURIComponent(input.replyId)}/edit`, { method: "POST", headers: commandHeaders({ action, id: input.replyId, revision, csrfToken }), body: JSON.stringify({ text: input.text }) });
    if (action === "approve") return api.request(`/api/replies/${encodeURIComponent(input.replyId)}/approve`, { method: "POST", headers: commandHeaders({ action, id: input.replyId, revision, csrfToken }), body: "{}" });
    throw new Error("Unsupported Inbox command");
  }, [csrfToken, detail]);

  return (
    <section className={`inbox-workspace${inspectorOpen ? "" : " is-inspector-collapsed"}`} aria-label="กล่องข้อความรวม">
      <InboxQueue items={items} selectedId={selectedId} onSelect={choose} state={listState} onRetry={loadList} />
      <div className="inbox-focus">
        <header className="inbox-focus__toolbar">
          <div className="inbox-focus__identity"><span className="inbox-avatar" aria-hidden="true">{(detail?.participant?.label ?? selectedSummary?.participant?.label ?? "R").slice(0, 1)}</span><div><strong>{detail?.participant?.label ?? selectedSummary?.participant?.label ?? "เลือกรายการสนทนา"}</strong><span>{detail?.channel === "facebook_group" ? detail?.source?.name : "Facebook Page Inbox"}</span></div></div>
          <div className="inbox-focus__status">{receipt ? <span className="inbox-updated" role="status"><i />อัปเดตแล้ว</span> : null}<button type="button" className="inbox-icon-button" aria-label={inspectorOpen ? "ซ่อนข้อมูลลีด" : "แสดงข้อมูลลีด"} onClick={() => setInspectorOpen((value) => !value)}>{inspectorOpen ? <PanelRightClose size={19} /> : <PanelRightOpen size={19} />}</button></div>
        </header>
        <div className="inbox-focus__scroll"><ConversationPane detail={detail} loading={detailState.loading} error={detailState.error} onRetry={() => loadDetail(selectedId)} /></div>
        {detail && !detailState.error ? <ReplyComposer detail={detail} runCommand={runCommand} onRefresh={() => loadDetail(selectedId)} commandsReady={Boolean(csrfToken)} /> : null}
      </div>
      <LeadInspector detail={detail} loading={detailState.loading} open={inspectorOpen} onClose={() => setInspectorOpen(false)} />
    </section>
  );
}

export default function InboxPage() {
  return <Suspense fallback={<div className="inbox-route-loading" aria-label="กำลังเปิด Inbox" />}><InboxWorkspace /></Suspense>;
}
