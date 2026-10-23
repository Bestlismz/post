"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { ConversationPane } from "./conversation-pane";
import { LeadInspector } from "./lead-inspector";
import { ReplyComposer } from "./reply-composer";

export function FocusSheet({ open, detail, loading, error, onRetry, onClose, runCommand, onRefresh, commandsReady }) {
  const dialogRef = useRef(null);
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
  return <div className="focus-sheet__backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="focus-sheet" role="dialog" aria-modal="true" aria-label="รายละเอียดลีด" tabIndex={-1} ref={dialogRef}>
      <header className="focus-sheet__header"><div><span>รายละเอียดลีด</span><strong>{detail?.participant?.label ?? "กำลังเปิดรายการ"}</strong></div><button type="button" aria-label="ปิดรายละเอียดลีด" onClick={onClose}><X size={20} /></button></header>
      <div className="focus-sheet__body"><div className="focus-sheet__work"><div className="focus-sheet__conversation"><ConversationPane detail={detail} loading={loading} error={error} onRetry={onRetry} runCommand={runCommand} onRefresh={onRefresh} commandsReady={commandsReady} /></div>{detail && !error && !detail.deliveries?.some((delivery) => delivery.state === "sent") ? <ReplyComposer detail={detail} runCommand={runCommand} onRefresh={onRefresh} commandsReady={commandsReady} /> : null}</div><LeadInspector detail={detail} loading={loading} open onClose={onClose} /></div>
    </section>
  </div>;
}
