"use client";

import { useEffect, useState } from "react";
import { Inbox, MessageCircleMore, RotateCcw, Search, SlidersHorizontal, UsersRound, X } from "lucide-react";

const statusLabels = { pending: "ใหม่", pending_or_updated: "ใหม่หรืออัปเดต", preparing: "กำลังวิเคราะห์", needs_review: "ต้องตรวจ", ready: "รอส่ง", completed: "เสร็จแล้ว", superseded: "มีข้อมูลใหม่", handoff: "ทีมดูแล", failed: "ต้องแก้ไข" };
function timeLabel(value) {
  const date = new Date(value); if (!Number.isFinite(date.valueOf())) return "";
  return new Intl.DateTimeFormat("th-TH", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Bangkok" }).format(date);
}
function budgetLabel(value) { return Number.isFinite(Number(value)) ? `฿${new Intl.NumberFormat("th-TH").format(Number(value))}` : "ยังไม่ระบุ"; }
function channelLabel(channel) { return channel === "facebook_group" ? "Facebook Group" : "Messenger"; }

function InboxRefreshError({ state, hasItems, onRetry }) {
  if (!state.error || !hasItems) return null;
  return <div className="inbox-refresh-error" role="alert"><span><strong>ข้อมูลอาจไม่ใช่ข้อมูลล่าสุด</strong><small>การโหลดครั้งล่าสุดไม่สำเร็จ รายการเดิมยังใช้งานได้</small></span><button type="button" onClick={onRetry}><RotateCcw size={15} />ลองโหลดคิวอีกครั้ง</button></div>;
}

function InboxFilterBar({ filters, onChange, resultCount }) {
  const [draft, setDraft] = useState({ search: filters.search, location: filters.location, budgetMin: filters.budgetMin, budgetMax: filters.budgetMax });
  useEffect(() => setDraft({ search: filters.search, location: filters.location, budgetMin: filters.budgetMin, budgetMax: filters.budgetMax }), [filters.search, filters.location, filters.budgetMin, filters.budgetMax]);
  const clear = () => onChange({ channel: null, status: null, location: null, budgetMin: null, budgetMax: null, assignee: null, q: null });
  const submit = (event) => { event.preventDefault(); onChange({ q: draft.search.trim() || null, location: draft.location.trim() || null, budgetMin: draft.budgetMin || null, budgetMax: draft.budgetMax || null }); };
  const active = Object.values(filters).some(Boolean);
  return <div className="inbox-filter-shell">
    <form className="inbox-filter-bar" onSubmit={submit} aria-label="ตัวกรอง Inbox">
      <label className="inbox-filter-search"><Search size={17} /><span className="rr-sr-only">ค้นหา</span><input aria-label="ค้นหา" type="search" value={draft.search} onChange={(event) => setDraft((value) => ({ ...value, search: event.target.value }))} placeholder="ค้นหาลูกค้า ข้อความ หรือแหล่งที่มา" /><button type="submit" aria-label="ค้นหา Inbox">ค้นหา</button></label>
      <label><span>ช่องทาง</span><select aria-label="ช่องทาง" value={filters.channel} onChange={(event) => onChange({ channel: event.target.value || null })}><option value="">ทุกช่องทาง</option><option value="facebook_group">Facebook Group</option><option value="messenger">Messenger</option></select></label>
      <label><span>สถานะ</span><select aria-label="สถานะ" value={filters.status} onChange={(event) => onChange({ status: event.target.value || null })}><option value="">ทุกสถานะ</option>{Object.entries(statusLabels).map(([value,label]) => <option value={value} key={value}>{label}</option>)}</select></label>
      <label><span>ทำเล</span><input aria-label="ทำเล" value={draft.location} onChange={(event) => setDraft((value) => ({ ...value, location: event.target.value }))} placeholder="เช่น อโศก" /></label>
      <label><span>งบต่ำสุด</span><input aria-label="งบต่ำสุด" inputMode="numeric" pattern="[0-9]*" value={draft.budgetMin} onChange={(event) => setDraft((value) => ({ ...value, budgetMin: event.target.value.replace(/\D/g, "").slice(0, 10) }))} placeholder="฿0" /></label>
      <label><span>งบสูงสุด</span><input aria-label="งบสูงสุด" inputMode="numeric" pattern="[0-9]*" value={draft.budgetMax} onChange={(event) => setDraft((value) => ({ ...value, budgetMax: event.target.value.replace(/\D/g, "").slice(0, 10) }))} placeholder="ไม่จำกัด" /></label>
      <label><span>ผู้ดูแล</span><select aria-label="ผู้ดูแล" value={filters.assignee} onChange={(event) => onChange({ assignee: event.target.value || null })}><option value="">ทุกคน</option><option value="unassigned">ยังไม่มอบหมาย</option></select></label>
      <button className="inbox-filter-apply" type="submit"><SlidersHorizontal size={16} />ใช้ตัวกรอง</button>
      {active ? <button className="inbox-filter-clear" type="button" onClick={clear}><X size={16} />ล้างตัวกรอง</button> : null}
    </form>
    <p className="inbox-filter-result" role="status"><strong>{new Intl.NumberFormat("th-TH").format(resultCount)}</strong> รายการ</p>
  </div>;
}

export function InboxTable({ items, resultCount = items.length, nextCursor = null, selectedId, onSelect, state, onRetry, onLoadMore, filters, onFiltersChange, obscured = false }) {
  const content = items.map((item) => ({ ...item, location: item.summary?.location ?? "ยังไม่ระบุ", budget: budgetLabel(item.summary?.budgetMax), assigneeLabel: item.summary?.assignee?.label ?? "ยังไม่มอบหมาย" }));
  const empty = !state.loading && !state.error && !content.length;
  return <section className="inbox-table" aria-label="Inbox แบบตาราง" aria-hidden={obscured || undefined} inert={obscured || undefined}>
    <header className="inbox-table__header"><div><h1>Inbox</h1><p>คัดแยกงานจำนวนมากโดยไม่เสียบริบท</p></div></header>
    <InboxFilterBar filters={filters} onChange={onFiltersChange} resultCount={resultCount} />
    <InboxRefreshError state={state} hasItems={items.length > 0} onRetry={onRetry} />
    {state.loading && !items.length ? <div className="inbox-queue-skeleton" aria-label="กำลังโหลดคิว"><i /><i /><i /><i /></div> : null}
    {state.error && !items.length ? <div className="inbox-region-error"><Inbox size={24} /><strong>โหลดคิวไม่ได้</strong><p>ข้อมูลเดิมยังไม่ถูกเปลี่ยนแปลง</p><button type="button" onClick={onRetry}><RotateCcw size={16} />ลองอีกครั้ง</button></div> : null}
    {empty ? <div className="inbox-empty-list"><Inbox size={26} /><strong>ไม่พบรายการที่ตรงกับตัวกรอง</strong><span>ลองปรับเงื่อนไขหรือล้างตัวกรองเพื่อดูรายการทั้งหมด</span></div> : null}
    {content.length ? <div className="inbox-table__scroll">
      <table aria-label="รายการ Inbox"><thead><tr><th>ช่องทาง</th><th>ลูกค้า / กลุ่ม</th><th>ข้อความล่าสุด</th><th>ทำเล</th><th>งบประมาณ</th><th>แหล่งที่มา</th><th>ผู้ดูแล</th><th>สถานะ</th><th>เวลา</th></tr></thead><tbody>{content.map((item) => <tr key={item.id} tabIndex={0} aria-selected={item.id === selectedId} onClick={(event) => onSelect(item.id, event.currentTarget)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(item.id, event.currentTarget); } }}><td><span className="inbox-table__channel">{item.channel === "facebook_group" ? <UsersRound size={15} /> : <MessageCircleMore size={15} />}{channelLabel(item.channel)}</span></td><td><strong>{item.participant?.label ?? "ไม่ระบุชื่อ"}</strong></td><td><span className="inbox-table__message">{item.message?.text}</span></td><td>{item.location}</td><td>{item.budget}</td><td>{item.source?.name ?? "—"}</td><td>{item.assigneeLabel}</td><td><span className={`inbox-table__status inbox-table__status--${item.status}`}><i />{statusLabels[item.status] ?? item.status}</span></td><td><time>{timeLabel(item.createdAt)}</time></td></tr>)}</tbody></table>
      <div className="inbox-row-list" role="list" aria-label="รายการ Inbox">{content.map((item) => <div role="listitem" key={item.id}><button type="button" aria-label={`${item.participant?.label ?? "ไม่ระบุชื่อ"} ${item.message?.text ?? ""}`} onClick={(event) => onSelect(item.id, event.currentTarget)}><span className="inbox-row-list__top"><strong>{item.participant?.label ?? "ไม่ระบุชื่อ"}</strong><time>{timeLabel(item.createdAt)}</time></span><span className="inbox-row-list__message">{item.message?.text}</span><span className="inbox-row-list__facts"><em>{channelLabel(item.channel)}</em><span>{item.location}</span><span>{item.budget}</span><span>{statusLabels[item.status] ?? item.status}</span></span></button></div>)}</div>
      {nextCursor && !state.loading ? <div className="inbox-table__more"><button type="button" onClick={onLoadMore} disabled={state.loadingMore}>{state.loadingMore ? "กำลังโหลด…" : "โหลดเพิ่ม"}<span>{content.length} จาก {resultCount}</span></button></div> : null}
    </div> : null}
  </section>;
}
