"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock3, PauseCircle, PlayCircle, RefreshCw, Settings2, ShieldAlert } from "lucide-react";
import { api } from "../lib/api-client.mjs";
import { PolicyEditor } from "./policy-editor";
import { PolicyPreview } from "./policy-preview";
import "../sources-automations.css";

const operationKey = () => globalThis.crypto?.randomUUID?.() ?? `automation-${Date.now()}-${Math.random()}`;
const fallbackPolicy = { mode: "approval", minimumConfidence: 0.82, rateLimits: { organization: 100, source: 20, conversation: 2 }, businessHours: { timeZone: "Asia/Bangkok", days: [1, 2, 3, 4, 5], start: "08:00", end: "19:00" } };

export default function AutomationsPage() {
  const [data, setData] = useState(null), [error, setError] = useState(""), [busy, setBusy] = useState(""), [notice, setNotice] = useState("");
  const csrfRef = useRef("");
  const load = useCallback(async () => { setError(""); try { const value = await api.request("/api/automation"); setData({ ...value, policy: { value: { ...fallbackPolicy, ...value.policy?.value, rateLimits: { ...fallbackPolicy.rateLimits, ...value.policy?.value?.rateLimits }, businessHours: { ...fallbackPolicy.businessHours, ...value.policy?.value?.businessHours } }, revision: value.policy?.revision ?? 1 } }); } catch (caught) { setError(caught.message); } }, []);
  useEffect(() => { void load(); }, [load]);
  async function csrf(force = false) { if (!force && csrfRef.current) return csrfRef.current; const result = await api.request("/api/auth/csrf", { method: "POST" }); csrfRef.current = result.csrfToken; return csrfRef.current; }
  async function mutate(path, { method = "POST", body = {}, revision, key = operationKey() } = {}) { const send = async (token) => api.request(path, { method, headers: { "X-CSRF-Token": token, "Idempotency-Key": key, ...(revision == null ? {} : { "If-Match": `"${revision}"` }) }, body: JSON.stringify(body) }); let token = await csrf(); try { return await send(token); } catch (caught) { if (caught.status !== 403) throw caught; token = await csrf(true); return send(token); } }
  async function setGlobalPause(paused) { setBusy("global"); try { const result = await mutate("/api/automation/pause", { body: { paused } }); setData((current) => ({ ...current, paused, receipts: [{ id: result.receiptId, scope: "organization", paused, reasonCode: result.reasonCode, createdAt: new Date().toISOString() }, ...(current.receipts ?? [])] })); setNotice(paused ? "หยุดการส่งใหม่ทั่วทั้งระบบแล้ว" : "เปิดรับงานอัตโนมัติใหม่แล้ว"); } catch (caught) { setNotice(caught.message); } finally { setBusy(""); } }
  async function setSourcePause(source, paused) { setBusy(`${source.id}:pause`); try { const result = await mutate(`/api/automation/sources/${source.id}/pause`, { body: { paused } }); setData((current) => ({ ...current, sources: current.sources.map((entry) => entry.id === source.id ? { ...entry, paused } : entry), receipts: [{ id: result.receiptId, scope: "source", sourceId: source.id, paused, reasonCode: result.reasonCode, createdAt: new Date().toISOString() }, ...(current.receipts ?? [])] })); } catch (caught) { setNotice(caught.message); } finally { setBusy(""); } }
  async function savePolicy(value) { setBusy("policy"); try { const saved = await mutate("/api/automation/policy", { method: "PUT", body: value, revision: data.policy.revision }); setData((current) => ({ ...current, policy: saved })); setNotice(`บันทึกกติกา revision ${saved.revision} แล้ว`); } catch (caught) { setNotice(caught.message); } finally { setBusy(""); } }
  async function saveFormat(value) { setBusy("format"); try { const saved = await mutate("/api/automation/reply-format", { method: "PUT", body: value, revision: data.replyFormat.revision }); setData((current) => ({ ...current, replyFormat: saved })); setNotice(`บันทึกรูปแบบคำตอบ revision ${saved.revision} แล้ว`); } catch (caught) { setNotice(caught.message); } finally { setBusy(""); } }
  async function saveSchedule(source, schedule) { setBusy(`${source.id}:schedule`); try { const saved = await mutate(`/api/automation/sources/${source.id}/schedule`, { method: "PUT", body: schedule, revision: source.schedule?.revision ?? 0 }); setData((current) => ({ ...current, sources: current.sources.map((entry) => entry.id === source.id ? { ...entry, schedule: { ...saved.schedule, revision: saved.revision } } : entry) })); setNotice("บันทึกตารางสแกนแล้ว"); } catch (caught) { setNotice(caught.message); } finally { setBusy(""); } }
  async function saveSourcePolicy(source, policy) { setBusy(`${source.id}:policy`); try { const saved = await mutate(`/api/sources/groups/${source.id}`, { method: "PATCH", body: { policy }, revision: source.revision }); setData((current) => ({ ...current, sources: current.sources.map((entry) => entry.id === source.id ? { ...entry, policy: saved.policy, revision: saved.revision } : entry) })); setNotice("บันทึก policy รายแหล่งแล้ว"); } catch (caught) { setNotice(caught.message); } finally { setBusy(""); } }

  return <div className="ops-page automations-page">
    <header className="ops-heading"><div><p>Decision controls</p><h1>กติกาอัตโนมัติ</h1><span>จุดเดียวสำหรับ threshold, ตารางเวลา, รูปแบบคำตอบ และ kill switch ที่ใช้กับ production evaluator</span></div>{data ? <div className={`automation-state${data.paused ? " is-paused" : ""}`}><i/>{data.paused ? "หยุดทั้งระบบ" : "พร้อมประเมินงานใหม่"}</div> : null}</header>
    {notice ? <div className="ops-notice" role="status"><CheckCircle2 size={17}/><span>{notice}</span></div> : null}
    {error ? <div className="ops-error" role="alert"><AlertTriangle size={17}/><span>{error}</span><button onClick={load}><RefreshCw size={16}/>ลองอีกครั้ง</button></div> : null}
    {!data ? <div className="ops-content"><div className="ops-skeleton">กำลังโหลดกติกา…</div></div> : <div className="automation-layout">
      <main className="automation-main">
        <PolicyEditor policy={data.policy.value} replyFormat={data.replyFormat.value} disabled={data.actorRole !== "admin"} busy={busy} onSavePolicy={savePolicy} onSaveFormat={saveFormat}/>
        <section className="ops-section automation-sources"><div className="ops-section__head"><div><span className="ops-section__icon"><Clock3 size={18}/></span><div><h2>ตารางและการหยุดรายแหล่ง</h2><p>โหมดส่งปรับที่ Sources เท่านั้น ส่วนตารางและ kill switch อยู่ที่นี่</p></div></div><Link className="ops-text-link" href="/sources">ไปที่ Sources</Link></div>
          <div className="automation-source-list">{data.sources.map((source) => <ScheduleRow key={source.id} source={source} globalPolicy={data.policy.value} admin={data.actorRole === "admin"} busy={busy} onPause={setSourcePause} onSave={saveSchedule} onSavePolicy={saveSourcePolicy}/>)}</div>
        </section>
      </main>
      <aside className="automation-aside">
        <section className={`kill-switch${data.paused ? " is-paused" : ""}`}><span><ShieldAlert size={20}/></span><h2>Global kill switch</h2><p>หยุดเฉพาะงานส่งใหม่ งานที่กำลังทำและหลักฐานเดิมไม่ถูกแก้ไข</p><button className={`ops-button ${data.paused ? "ops-button--primary" : "ops-button--danger"}`} type="button" disabled={busy === "global" || data.actorRole !== "admin"} onClick={() => setGlobalPause(!data.paused)}>{data.paused ? <PlayCircle size={17}/> : <PauseCircle size={17}/>} {data.paused ? "เปิดรับงานอัตโนมัติ" : "หยุดการส่งอัตโนมัติทั้งหมด"}</button></section>
        <PolicyPreview policy={data.policy.value}/>
        <section className="receipt-ledger"><header><Settings2 size={17}/><div><h2>Control receipts</h2><p>หลักฐานถาวรจากการเปลี่ยนสถานะ</p></div></header>{data.receipts?.length ? <ol>{data.receipts.slice(0, 8).map((receipt) => <li key={receipt.id}><i className={receipt.paused ? "is-paused" : ""}/><div><strong>{receipt.reasonCode}</strong><span>{receipt.scope === "organization" ? "ทั้งระบบ" : "รายแหล่ง"} · {new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bangkok" }).format(new Date(receipt.createdAt))}</span></div></li>)}</ol> : <p className="receipt-ledger__empty">ยังไม่มีการเปลี่ยน kill switch</p>}</section>
      </aside>
    </div>}
  </div>;
}

function ScheduleRow({ source, globalPolicy, admin, busy, onPause, onSave, onSavePolicy }) {
  const base = source.schedule ?? { enabled: true, cadenceMinutes: 15, timeZone: "Asia/Bangkok", days: [0, 1, 2, 3, 4, 5, 6], start: "08:00", end: "20:00", dailyLimit: 48, maintenanceWindows: [], revision: 0 };
  const inheritedPolicy = source.policy?.rateLimits && source.policy?.businessHours ? source.policy : { rateLimits: globalPolicy.rateLimits, businessHours: globalPolicy.businessHours };
  const [draft, setDraft] = useState(base);
  const [sourceLimit, setSourceLimit] = useState(inheritedPolicy.rateLimits.source);
  useEffect(() => { setDraft(base); }, [source.schedule]);
  useEffect(() => { setSourceLimit(inheritedPolicy.rateLimits.source); }, [source.policy, globalPolicy]);
  const update = (field, value) => setDraft((current) => ({ ...current, [field]: value }));
  return <article className="automation-source-row"><div className="automation-source-row__identity"><strong>{source.label}</strong><span>โหมด {source.mode === "automatic" ? "Automatic" : source.mode === "approval" ? "Approval" : "Observe"}</span></div><div className="schedule-fields"><label>ทุก ๆ<select value={draft.cadenceMinutes} disabled={!admin} onChange={(event) => update("cadenceMinutes", Number(event.target.value))}><option value="15">15 นาที</option><option value="30">30 นาที</option><option value="60">60 นาที</option></select></label><label>เริ่ม<input type="time" value={draft.start} disabled={!admin} onChange={(event) => update("start", event.target.value)}/></label><label>สิ้นสุด<input type="time" value={draft.end} disabled={!admin} onChange={(event) => update("end", event.target.value)}/></label><label>สูงสุด/วัน<input type="number" min="1" max="1440" value={draft.dailyLimit} disabled={!admin} onChange={(event) => update("dailyLimit", Number(event.target.value))}/></label><label>ส่ง/ชม.<input type="number" min="1" max="1000" value={sourceLimit} disabled={!admin} onChange={(event) => setSourceLimit(Number(event.target.value))}/></label></div><div className="automation-source-row__actions"><button className="ops-button ops-button--secondary" type="button" disabled={!admin || busy === `${source.id}:schedule`} onClick={() => onSave(source, draft)}>บันทึกตาราง</button><button className="ops-button ops-button--secondary" type="button" disabled={!admin || busy === `${source.id}:policy`} onClick={() => onSavePolicy(source, { ...inheritedPolicy, rateLimits: { ...inheritedPolicy.rateLimits, source: sourceLimit } })}>บันทึก policy</button><button className={`ops-button ${source.paused ? "ops-button--primary" : "ops-button--quiet-danger"}`} type="button" disabled={!admin || busy === `${source.id}:pause`} onClick={() => onPause(source, !source.paused)}>{source.paused ? "เปิดแหล่งนี้" : "พักแหล่งนี้"}</button></div></article>;
}
