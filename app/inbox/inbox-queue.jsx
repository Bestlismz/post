"use client";

import { Inbox, MessageCircleMore, RotateCcw, UsersRound } from "lucide-react";
import { useState } from "react";

const statusLabels = { pending: "ใหม่", preparing: "กำลังวิเคราะห์", needs_review: "ต้องตรวจ", ready: "รอส่ง", completed: "เสร็จแล้ว", superseded: "มีข้อมูลใหม่", handoff: "ทีมดูแล", failed: "ต้องแก้ไข" };
function timeLabel(value) {
  const date = new Date(value); if (!Number.isFinite(date.valueOf())) return "";
  return new Intl.DateTimeFormat("th-TH", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Bangkok" }).format(date);
}

export function InboxQueue({ items, selectedId, onSelect, state, onRetry }) {
  const [filter, setFilter] = useState("all");
  const visibleItems = filter === "review" ? items.filter((item) => item.status === "needs_review") : items;
  return <aside className="inbox-queue" aria-label="คิวข้อความ">
    <header className="inbox-queue__header"><div><h1>Inbox</h1><p>ทุกช่องทางในที่เดียว</p></div><span className="inbox-count" aria-label={`${items.length} รายการ`}>{items.length}</span></header>
    <div className="inbox-queue__filters" aria-label="ตัวกรองคิว"><button className={filter === "all" ? "is-active" : ""} type="button" onClick={() => setFilter("all")}>ทั้งหมด <span>{items.length}</span></button><button className={filter === "review" ? "is-active" : ""} type="button" onClick={() => setFilter("review")}>ต้องตรวจ <span>{items.filter((item) => item.status === "needs_review").length}</span></button></div>
    <div className="inbox-queue__list">
      {state.loading && !items.length ? <div className="inbox-queue-skeleton" aria-label="กำลังโหลดคิว"><i /><i /><i /><i /></div> : null}
      {state.error && !items.length ? <div className="inbox-region-error"><Inbox size={24} /><strong>โหลดคิวไม่ได้</strong><p>คิวส่วนอื่นยังไม่เปลี่ยนแปลง</p><button type="button" onClick={onRetry}><RotateCcw size={16} />ลองอีกครั้ง</button></div> : null}
      {!state.loading && !state.error && !items.length ? <div className="inbox-empty-list"><Inbox size={26} /><strong>ยังไม่มีข้อความใหม่</strong><span>รายการจากกลุ่มและ Messenger จะปรากฏที่นี่</span></div> : null}
      {visibleItems.map((item) => {
        const selected = item.id === selectedId;
        return <button className={`inbox-queue-row${selected ? " is-selected" : ""}`} type="button" key={item.id} onClick={() => onSelect(item.id)} aria-pressed={selected} aria-label={`${item.participant?.label ?? "ไม่ระบุชื่อ"} ${item.message?.text ?? ""}`}>
          <span className="inbox-avatar inbox-avatar--queue" aria-hidden="true">{(item.participant?.label ?? "R").slice(0, 1)}</span>
          <span className="inbox-queue-row__content"><span className="inbox-queue-row__top"><strong>{item.participant?.label ?? "ไม่ระบุชื่อ"}</strong><time>{timeLabel(item.createdAt)}</time></span><span className="inbox-queue-row__preview">{item.message?.text}</span><span className="inbox-queue-row__meta">{item.channel === "facebook_group" ? <UsersRound size={14} /> : <MessageCircleMore size={14} />}{item.channel === "facebook_group" ? "Facebook Group" : "Messenger"}<i className={`inbox-state-dot inbox-state-dot--${item.status}`} /><em>{statusLabels[item.status] ?? item.status}</em></span></span>
        </button>;
      })}
    </div>
  </aside>;
}
