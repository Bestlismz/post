"use client";

import { Inbox, LayoutList, MessageCircleMore, RotateCcw, Rows3, UsersRound } from "lucide-react";

const statusLabels = { pending: "ใหม่", preparing: "กำลังวิเคราะห์", needs_review: "ต้องตรวจ", ready: "รอส่ง", completed: "เสร็จแล้ว", superseded: "มีข้อมูลใหม่", handoff: "ทีมดูแล", failed: "ต้องแก้ไข" };
function timeLabel(value) {
  const date = new Date(value); if (!Number.isFinite(date.valueOf())) return "";
  return new Intl.DateTimeFormat("th-TH", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Bangkok" }).format(date);
}

function visibleInboxItems(items, filter) {
  return filter === "needs_review" ? items.filter((item) => item.status === "needs_review") : items;
}

function InboxFilters({ items, filter, onFilterChange }) {
  const reviewCount = items.filter((item) => item.status === "needs_review").length;
  return <div className="inbox-queue__filters" aria-label="ตัวกรองคิว"><button aria-pressed={filter === "all"} className={filter === "all" ? "is-active" : ""} type="button" onClick={() => onFilterChange("all")}>ทั้งหมด <span>{items.length}</span></button><button aria-pressed={filter === "needs_review"} className={filter === "needs_review" ? "is-active" : ""} type="button" onClick={() => onFilterChange("needs_review")}>ต้องตรวจ <span>{reviewCount}</span></button></div>;
}

export function InboxViewSwitch({ view, onViewChange }) {
  return <div className="inbox-view-switch" aria-label="รูปแบบ Inbox"><button type="button" aria-label="มุมมองพื้นที่ทำงาน" aria-pressed={view === "workspace"} onClick={() => onViewChange("workspace")}><LayoutList size={17} />พื้นที่ทำงาน</button><button type="button" aria-label="มุมมองตาราง" aria-pressed={view === "table"} onClick={() => onViewChange("table")}><Rows3 size={17} />ตาราง</button></div>;
}

export function InboxQueue({ items, selectedId, onSelect, state, onRetry, filter, onFilterChange, view = "workspace", onViewChange }) {
  const visibleItems = visibleInboxItems(items, filter);
  return <aside className="inbox-queue" aria-label="คิวข้อความ">
    <header className="inbox-queue__header"><div><h1>Inbox</h1><p>ทุกช่องทางในที่เดียว</p></div><span className="inbox-count" aria-label={`${items.length} รายการ`}>{items.length}</span></header>
    {onViewChange ? <InboxViewSwitch view={view} onViewChange={onViewChange} /> : null}
    <InboxFilters items={items} filter={filter} onFilterChange={onFilterChange} />
    <div className="inbox-queue__list">
      {state.loading && !items.length ? <div className="inbox-queue-skeleton" aria-label="กำลังโหลดคิว"><i /><i /><i /><i /></div> : null}
      {state.error && !items.length ? <div className="inbox-region-error"><Inbox size={24} /><strong>โหลดคิวไม่ได้</strong><p>คิวส่วนอื่นยังไม่เปลี่ยนแปลง</p><button type="button" onClick={onRetry}><RotateCcw size={16} />ลองอีกครั้ง</button></div> : null}
      {!state.loading && !state.error && !items.length ? <div className="inbox-empty-list"><Inbox size={26} /><strong>ยังไม่มีข้อความใหม่</strong><span>รายการจากกลุ่มและ Messenger จะปรากฏที่นี่</span></div> : null}
      {!state.loading && !state.error && items.length && !visibleItems.length ? <div className="inbox-empty-list"><Inbox size={26} /><strong>ไม่มีรายการที่ต้องตรวจ</strong><span>เลือกตัวกรองทั้งหมดเพื่อดูรายการอื่น</span></div> : null}
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

function budgetLabel(value) {
  return Number.isFinite(Number(value)) ? `฿${new Intl.NumberFormat("th-TH").format(Number(value))}` : "ยังไม่ระบุ";
}

function channelLabel(channel) {
  return channel === "facebook_group" ? "Facebook Group" : "Messenger";
}

export function InboxTable({ items, selectedId, onSelect, state, onRetry, filter, onFilterChange, view, onViewChange, obscured = false }) {
  const visibleItems = visibleInboxItems(items, filter);
  const content = visibleItems.map((item) => ({
    ...item,
    location: item.requirements?.district ?? item.extractedRequirements?.district ?? "ยังไม่ระบุ",
    budget: budgetLabel(item.requirements?.budgetMax ?? item.extractedRequirements?.budgetMax),
    assigneeLabel: item.assignee?.label ?? "ยังไม่มอบหมาย",
  }));
  const empty = !state.loading && !state.error && !content.length;
  return <section className="inbox-table" aria-label="Inbox แบบตาราง" aria-hidden={obscured || undefined} inert={obscured || undefined}>
    <header className="inbox-table__header"><div><h1>Inbox</h1><p>คัดแยกงานจำนวนมากโดยไม่เสียบริบท</p></div><InboxViewSwitch view={view} onViewChange={onViewChange} /></header>
    <InboxFilters items={items} filter={filter} onFilterChange={onFilterChange} />
    {state.loading && !items.length ? <div className="inbox-queue-skeleton" aria-label="กำลังโหลดคิว"><i /><i /><i /><i /></div> : null}
    {state.error && !items.length ? <div className="inbox-region-error"><Inbox size={24} /><strong>โหลดคิวไม่ได้</strong><p>ข้อมูลเดิมยังไม่ถูกเปลี่ยนแปลง</p><button type="button" onClick={onRetry}><RotateCcw size={16} />ลองอีกครั้ง</button></div> : null}
    {empty ? <div className="inbox-empty-list"><Inbox size={26} /><strong>{filter === "needs_review" ? "ไม่มีรายการที่ต้องตรวจ" : "ยังไม่มีข้อความใหม่"}</strong><span>{filter === "needs_review" ? "เลือกตัวกรองทั้งหมดเพื่อดูรายการอื่น" : "รายการจากกลุ่มและ Messenger จะปรากฏที่นี่"}</span></div> : null}
    {content.length ? <div className="inbox-table__scroll">
      <table aria-label="รายการ Inbox"><thead><tr><th>ช่องทาง</th><th>ลูกค้า / กลุ่ม</th><th>ข้อความล่าสุด</th><th>ทำเล</th><th>งบประมาณ</th><th>แหล่งที่มา</th><th>ผู้ดูแล</th><th>สถานะ</th><th>เวลา</th></tr></thead><tbody>{content.map((item) => <tr key={item.id} tabIndex={0} aria-selected={item.id === selectedId} onClick={(event) => onSelect(item.id, event.currentTarget)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(item.id, event.currentTarget); } }}><td><span className="inbox-table__channel">{item.channel === "facebook_group" ? <UsersRound size={15} /> : <MessageCircleMore size={15} />}{channelLabel(item.channel)}</span></td><td><strong>{item.participant?.label ?? "ไม่ระบุชื่อ"}</strong></td><td><span className="inbox-table__message">{item.message?.text}</span></td><td>{item.location}</td><td>{item.budget}</td><td>{item.source?.name ?? "—"}</td><td>{item.assigneeLabel}</td><td><span className={`inbox-table__status inbox-table__status--${item.status}`}><i />{statusLabels[item.status] ?? item.status}</span></td><td><time>{timeLabel(item.createdAt)}</time></td></tr>)}</tbody></table>
      <div className="inbox-row-list" role="list" aria-label="รายการ Inbox">{content.map((item) => <div role="listitem" key={item.id}><button type="button" aria-label={`${item.participant?.label ?? "ไม่ระบุชื่อ"} ${item.message?.text ?? ""}`} onClick={(event) => onSelect(item.id, event.currentTarget)}><span className="inbox-row-list__top"><strong>{item.participant?.label ?? "ไม่ระบุชื่อ"}</strong><time>{timeLabel(item.createdAt)}</time></span><span className="inbox-row-list__message">{item.message?.text}</span><span className="inbox-row-list__facts"><em>{channelLabel(item.channel)}</em><span>{item.location}</span><span>{item.budget}</span><span>{statusLabels[item.status] ?? item.status}</span></span></button></div>)}</div>
    </div> : null}
  </section>;
}
