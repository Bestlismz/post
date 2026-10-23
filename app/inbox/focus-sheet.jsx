"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, PanelRightOpen, X } from "lucide-react";
import { ConversationPane } from "./conversation-pane";
import { LeadInspector } from "./lead-inspector";
import { ReplyComposer } from "./reply-composer";

export function FocusSheet({ open, detail, loading, error, onRetry, onClose, runCommand, onRefresh, commandsReady }) {
  const dialogRef = useRef(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  useEffect(() => { if (open) setInspectorOpen(false); }, [detail?.id, open]);
  useEffect(() => {
    if (!open) return undefined;
    const dialog = dialogRef.current;
    dialog?.focus({ preventScroll: true });
    const onKeyDown = (event) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab") return;
      const focusable = [...(dialog?.querySelectorAll('button:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])') ?? [])];
      if (!focusable.length) return;
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  if (!open) return null;
  const hasSent = detail?.deliveries?.some((delivery) => delivery.state === "sent");
  const composer = detail && !error && !hasSent ? <ReplyComposer detail={detail} runCommand={runCommand} onRefresh={onRefresh} commandsReady={commandsReady} /> : null;
  const groupReply = detail?.channel === "facebook_group";
  return <div className="focus-sheet__backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className={`focus-sheet${inspectorOpen ? " is-inspector-open" : ""}`} role="dialog" aria-modal="true" aria-label="โพสต์และความคิดเห็น" tabIndex={-1} ref={dialogRef}>
      <header className="focus-sheet__header"><button className="focus-sheet__back" type="button" aria-label="กลับไป Inbox" onClick={onClose}><ArrowLeft size={21} /></button><div><strong>{groupReply ? `โพสต์ของ ${detail?.participant?.label ?? "สมาชิกกลุ่ม"}` : detail?.participant?.label ?? "กำลังเปิดรายการ"}</strong><span>{groupReply ? detail?.source?.name ?? "Facebook Group" : "Messenger"}</span></div><div className="focus-sheet__actions"><button className={inspectorOpen ? "is-active" : ""} type="button" aria-pressed={inspectorOpen} aria-label="ข้อมูลช่วยตอบ" onClick={() => setInspectorOpen((value) => !value)}><PanelRightOpen size={19} /><span>ข้อมูลช่วยตอบ</span></button><button type="button" aria-label="ปิดรายละเอียดลีด" onClick={onClose}><X size={20} /></button></div></header>
      <div className="focus-sheet__body"><div className="focus-sheet__work"><div className="focus-sheet__conversation"><ConversationPane detail={detail} loading={loading} error={error} onRetry={onRetry} runCommand={runCommand} onRefresh={onRefresh} commandsReady={commandsReady} composer={groupReply ? composer : null} /></div>{!groupReply ? composer : null}</div><LeadInspector detail={detail} loading={loading} open={inspectorOpen} onClose={() => setInspectorOpen(false)} /></div>
    </section>
  </div>;
}
