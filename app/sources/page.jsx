"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink, MessagesSquare, Plus, RefreshCw, ShieldCheck, Unplug, X } from "lucide-react";
import { api } from "../lib/api-client.mjs";
import { BrowserRecovery } from "./browser-recovery";
import { createOperationPoller } from "./operation-poller.mjs";
import { operationStatusReducer } from "./operation-status.mjs";
import { applySavedSchedule } from "./schedule-state.mjs";
import { SourceRow } from "./source-row";
import "../sources-automations.css";

const exactGroupUrl = /^https:\/\/(?:www\.|m\.)?facebook\.com\/groups\/\d+\/?(?:\?[^#]*)?$/;
const operationKey = () => globalThis.crypto?.randomUUID?.() ?? `source-${Date.now()}-${Math.random()}`;

export default function SourcesPage() {
  const [data, setData] = useState({ actorRole: null, pages: [], groups: [] });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [groupUrl, setGroupUrl] = useState("");
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [expanded, setExpanded] = useState(null);
  const [browserHealth, setBrowserHealth] = useState({});
  const [recovery, setRecovery] = useState(null);
  const [recoveryReady, setRecoveryReady] = useState([]);
  const [pagePicker, setPagePicker] = useState(null);
  const [operationIssues, dispatchOperationIssue] = useReducer(operationStatusReducer, {});
  const csrfRef = useRef("");
  const pollersRef = useRef(new Map());

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoadError("");
    try { const next = await api.request("/api/sources"); setData(next); dispatchOperationIssue({ type: "reconcile", groups: next.groups }); return next; }
    catch (error) { if (quiet) throw error; setLoadError(error.message); return null; }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const pendingId = new URLSearchParams(window.location.search).get("meta");
    if (!pendingId) return undefined;
    let cancelled = false;
    setBusy("page-picker");
    void api.request(`/api/meta/connection/${encodeURIComponent(pendingId)}/pages`).then((pages) => {
      if (cancelled) return;
      setPagePicker({ pendingId, pages });
      window.history.replaceState({}, "", "/sources");
    }).catch((error) => { if (!cancelled) setNotice(error.status === 410 ? "รายการเชื่อมต่อหมดอายุ กรุณาเริ่มใหม่" : error.message); }).finally(() => { if (!cancelled) setBusy(""); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    const pendingStates = new Set(["pending", "queued", "running", "attempting", "awaiting_result"]);
    const pendingSources = data.groups.filter((source) => pendingStates.has(source.latestOperation?.state) && operationIssues[source.latestOperation.operationId]?.state !== "retry_required");
    const pending = new Set(pendingSources.map((source) => source.latestOperation.operationId));
    for (const [operationId, poller] of pollersRef.current) {
      if (!pending.has(operationId)) { poller.destroy(); pollersRef.current.delete(operationId); }
    }
    for (const source of pendingSources) {
      const operationId = source.latestOperation.operationId;
      if (pollersRef.current.has(operationId)) continue;
      const poller = createOperationPoller({ reload: async (id) => {
        const next = await load({ quiet: true });
        const state = next.groups.flatMap((entry) => entry.latestOperation ?? []).find((operation) => operation.operationId === id)?.state ?? "replaced";
        dispatchOperationIssue({ type: "retry_succeeded", operationId: id });
        return state;
      }, onFinalError: (id) => dispatchOperationIssue({ type: "retry_required", sourceId: source.id, operationId: id }) });
      pollersRef.current.set(operationId, poller);
      poller.start(operationId);
    }
  }, [data.groups, load, operationIssues]);
  useEffect(() => () => {
    for (const poller of pollersRef.current.values()) poller.destroy();
    pollersRef.current.clear();
  }, []);
  function retryOperation(source) {
    const operationId = source.latestOperation?.operationId;
    if (!operationId) return;
    pollersRef.current.get(operationId)?.destroy();
    pollersRef.current.delete(operationId);
    dispatchOperationIssue({ type: "retry_started", operationId });
  }

  async function csrf(force = false) {
    if (!force && csrfRef.current) return csrfRef.current;
    const result = await api.request("/api/auth/csrf", { method: "POST" });
    csrfRef.current = result.csrfToken;
    return csrfRef.current;
  }
  async function mutate(path, { method = "POST", body = {}, revision, key = operationKey() } = {}) {
    const send = async (token) => api.request(path, { method, headers: { "X-CSRF-Token": token, "Idempotency-Key": key, ...(revision == null ? {} : { "If-Match": `"${revision}"` }) }, body: JSON.stringify(body) });
    let token = await csrf();
    try { return await send(token); }
    catch (error) { if (error.status !== 403) throw error; token = await csrf(true); return send(token); }
  }
  async function addGroup(event) {
    event.preventDefault(); const value = groupUrl.trim();
    if (!exactGroupUrl.test(value)) { setFormError("ลิงก์ต้องเป็น Facebook Group แบบตัวเลขเท่านั้น"); return; }
    setBusy("add"); setFormError("");
    try { const result = await mutate("/api/sources/groups", { body: { url: value } }); const { created: wasCreated, ...source } = result; await load(); setAddOpen(false); setGroupUrl(""); setExpanded(source.id); setNotice(wasCreated ? "เพิ่มกลุ่มและเปิดตารางสแกนอัตโนมัติแล้ว" : "กลุ่มนี้ถูกเพิ่มไว้แล้ว แสดงรายการเดิมให้แล้ว"); requestAnimationFrame(() => document.querySelector(`[data-testid="source-${CSS.escape(source.id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" })); }
    catch (error) { setFormError(error.status === 422 ? "ลิงก์ต้องเป็น Facebook Group แบบตัวเลขเท่านั้น" : error.message); }
    finally { setBusy(""); }
  }
  async function setMode(source, mode) {
    setBusy(`${source.id}:mode`);
    try { const next = await mutate(`/api/sources/groups/${source.id}`, { method: "PATCH", revision: source.revision, body: { mode, ...(mode === "automatic" ? { allowListed: true } : {}) } }); setData((current) => ({ ...current, groups: current.groups.map((entry) => entry.id === source.id ? { ...entry, ...next } : entry) })); setNotice(`เปลี่ยนโหมดเป็น ${mode === "observe" ? "Observe" : mode === "approval" ? "Approval" : "Automatic"} แล้ว`); }
    catch (error) { setNotice(error.status === 409 ? "ยังเปิด Automatic ไม่ได้ กรุณาแก้สถานะสุขภาพและกติกาก่อน" : error.message); }
    finally { setBusy(""); }
  }
  async function scan(source, { recovery = false } = {}) {
    setBusy(`${source.id}:scan`);
    try { await mutate(`/api/sources/groups/${source.id}/scans`, { revision: source.revision, body: recovery ? { recovery: true } : {} }); setNotice(recovery ? "รับคำขอสแกนกู้คืนแล้ว กำลังตรวจ Facebook session และ selector ใหม่" : "รับคำขอสแกนแล้ว กำลังรอผลจาก browser worker"); await load(); }
    catch (error) { setNotice(error.reasonCode === "SELECTOR_CIRCUIT_OPEN" || error.reasonCode === "SESSION_CIRCUIT_OPEN" ? "แหล่งนี้ต้องสแกนกู้คืนก่อน จึงจะกลับมารับโพสต์ได้" : error.message); }
    finally { setBusy(""); }
  }
  async function setSchedule(source, cadenceMinutes) {
    const current = source.schedule ?? { enabled: true, cadenceMinutes: 15, timeZone: "Asia/Bangkok", days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "24:00", dailyLimit: 96, maintenanceWindows: [], revision: 0 };
    const schedule = { ...current, enabled: true, cadenceMinutes, dailyLimit: Math.ceil(1440 / cadenceMinutes) };
    delete schedule.revision;
    setBusy(`${source.id}:schedule`);
    try {
      const saved = await mutate(`/api/automation/sources/${source.id}/schedule`, { method: "PUT", revision: current.revision, body: schedule });
      setData((value) => ({ ...value, groups: applySavedSchedule(value.groups, source.id, saved) }));
      setNotice(`ตั้งให้สแกนอัตโนมัติทุก ${cadenceMinutes} นาทีแล้ว`);
    } catch (error) { setNotice(error.status === 409 ? "ตารางสแกนถูกแก้จากอีกหน้าหนึ่ง กรุณาโหลดใหม่แล้วลองอีกครั้ง" : error.message); }
    finally { setBusy(""); }
  }
  async function inspect(source) {
    const open = expanded === source.id ? null : source.id; setExpanded(open);
    if (!open || browserHealth[source.id]) return;
    setBusy(`${source.id}:health`);
    try { const health = await api.request(`/api/sources/${source.id}/browser-health`); setBrowserHealth((current) => ({ ...current, [source.id]: health })); }
    catch (error) { setBrowserHealth((current) => ({ ...current, [source.id]: { error: error.message } })); }
    finally { setBusy(""); }
  }
  async function beginRecovery(source) {
    setBusy(`${source.id}:recovery`);
    try { setRecovery(await mutate(`/api/sources/${source.id}/recovery`, { body: { ttlSeconds: 300 } })); setRecoveryReady((current) => current.filter((id) => id !== source.id)); await load({ quiet: true }); }
    catch (error) { setNotice(error.message); }
    finally { setBusy(""); }
  }
  async function closeRecovery() {
    const current = recovery; setRecovery(null);
    if (!current) return;
    try { await mutate(`/api/sources/${current.sourceId}/recovery/${current.sessionId}`, { method: "DELETE" }); setRecoveryReady((ids) => ids.includes(current.sourceId) ? ids : [...ids, current.sourceId]); setNotice("ปิดหน้ากู้คืนแล้ว แหล่งข้อมูลยังพักอยู่จนกว่าจะยืนยันและสแกนทดสอบ"); }
    catch (error) { setNotice(`หน้าต่างถูกปิดแล้ว แต่การยกเลิก lease ต้องรอหมดอายุ: ${error.message}`); }
    finally { await load(); }
  }
  async function resumeAfterRecovery(source) {
    if (!source) { setNotice("ไม่พบแหล่งข้อมูลสำหรับสแกนทดสอบ กรุณาปิดหน้าต่างแล้วลองอีกครั้ง"); return; }
    const current = recovery?.sourceId === source.id ? recovery : null;
    setBusy(`${source.id}:resume`);
    try {
      if (current) { await mutate(`/api/sources/${current.sourceId}/recovery/${current.sessionId}`, { method: "DELETE" }); setRecovery(null); }
      const snapshot = await load({ quiet: true });
      const latest = snapshot?.groups.find((entry) => entry.id === source.id);
      if (!latest) throw new Error("ไม่พบแหล่งข้อมูลที่ต้องการเปิดใช้งาน");
      const resumed = latest.paused ? await mutate(`/api/sources/groups/${source.id}`, { method: "PATCH", revision: latest.revision, body: { killSwitch: false } }) : latest;
      await mutate(`/api/sources/groups/${source.id}/scans`, { revision: resumed.revision, body: { recovery: true } });
      setRecoveryReady((ids) => ids.filter((id) => id !== source.id));
      setNotice("เปิดแหล่งข้อมูลแล้ว กำลังสแกนทดสอบเพื่อยืนยัน session และตัวอ่านโพสต์");
      await load();
    } catch (error) { if (current) setRecoveryReady((ids) => ids.includes(source.id) ? ids : [...ids, source.id]); setNotice(error.status === 409 ? "ยังเปิดแหล่งข้อมูลไม่ได้ กรุณาตรวจว่า Facebook แสดงหน้ากลุ่มปกติ แล้วลองยืนยันอีกครั้ง" : error.message); await load(); }
    finally { setBusy(""); }
  }
  async function connectPage() {
    setBusy("page-connect"); setNotice("");
    try {
      const result = await mutate("/api/meta/connection/begin");
      const target = new URL(result.authorizationUrl);
      if (target.protocol !== "https:" || target.hostname !== "www.facebook.com" || !/^\/v\d+\.\d+\/dialog\/oauth$/.test(target.pathname)) throw new Error("ลิงก์อนุญาต Facebook ไม่ถูกต้อง");
      window.location.assign(target.href);
    } catch (error) { setNotice(error.status === 503 ? "ยังไม่ได้ตั้งค่า Meta App สำหรับระบบนี้" : error.message); setBusy(""); }
  }
  async function selectPage(pageId) {
    if (!pagePicker) return;
    setBusy("page-select");
    try { await mutate(`/api/meta/connection/${encodeURIComponent(pagePicker.pendingId)}/select`, { body: { pageId } }); setPagePicker(null); setNotice("เชื่อมต่อ Facebook Page และเปิดรับ Messenger แล้ว"); await load(); }
    catch (error) { setNotice(error.message); }
    finally { setBusy(""); }
  }
  async function checkPage(page) {
    setBusy(`${page.id}:page-health`);
    try { const next = await api.request(`/api/meta/sources/${encodeURIComponent(page.id)}/health`); setData((current) => ({ ...current, pages: current.pages.map((entry) => entry.id === page.id ? { ...entry, ...next } : entry) })); setNotice("อัปเดตสถานะ Facebook Page แล้ว"); }
    catch (error) { setNotice(error.message); }
    finally { setBusy(""); }
  }
  async function disconnectPage(page) {
    if (!window.confirm(`ยกเลิกการเชื่อมต่อ ${page.name}? ระบบจะหยุดรับและตอบ Messenger ของเพจนี้`)) return;
    setBusy(`${page.id}:disconnect`);
    try { const next = await mutate(`/api/meta/sources/${encodeURIComponent(page.id)}/disconnect`); setData((current) => ({ ...current, pages: current.pages.map((entry) => entry.id === page.id ? { ...entry, ...next } : entry) })); setNotice("ยกเลิกการเชื่อมต่อ Facebook Page แล้ว"); }
    catch (error) { setNotice(error.message); }
    finally { setBusy(""); }
  }

  return <div className="ops-page sources-page">
    <header className="ops-heading"><div><p>Connections &amp; health</p><h1>แหล่งข้อมูล Facebook</h1><span>เพจและกลุ่มที่ได้รับอนุญาต พร้อมสถานะสแกนและ browser session จากระบบจริง</span></div>{data.actorRole === "admin" ? <button className="ops-button ops-button--primary" type="button" onClick={() => setAddOpen(true)}><Plus size={17}/>เพิ่มกลุ่ม</button> : null}</header>
    {notice ? <div className="ops-notice" role="status"><CheckCircle2 size={17}/><span>{notice}</span><button aria-label="ปิดข้อความ" onClick={() => setNotice("")}><X size={16}/></button></div> : null}
    {loadError ? <div className="ops-error" role="alert"><AlertTriangle size={17}/><span>{loadError}</span><button onClick={() => load()}><RefreshCw size={16}/>ลองอีกครั้ง</button></div> : null}
    <div className="ops-content">
      <section className="ops-section" aria-labelledby="page-source-title"><div className="ops-section__head"><div><span className="ops-section__icon"><MessagesSquare size={18}/></span><div><h2 id="page-source-title">Facebook Page</h2><p>Messenger ผ่าน Meta API ทางการ</p></div></div><div className="page-section-actions"><span className="ops-count">{data.pages.length} เพจ</span>{data.actorRole === "admin" ? <button className="ops-button ops-button--secondary" type="button" disabled={busy === "page-connect"} onClick={() => void connectPage()}><ExternalLink size={16}/>เชื่อมต่อเพจ</button> : null}</div></div>
        {loading ? <div className="ops-skeleton">กำลังโหลดการเชื่อมต่อ…</div> : data.pages.length ? data.pages.map((page) => <article className="page-source-row" key={page.id}><span className="page-source-row__mark"><MessagesSquare size={20}/></span><div className="page-source-row__identity"><strong>{page.name}</strong><p>รับและตอบข้อความผ่าน Facebook Page Inbox</p></div><span className={`health-label health-label--${page.health === "connected" ? "good" : "bad"}`}><i/>{page.health === "connected" ? "เชื่อมต่อแล้ว" : page.health === "disconnected" ? "ยกเลิกแล้ว" : "ต้องตรวจสอบ"}</span>{data.actorRole === "admin" ? <div className="page-row-actions"><button type="button" disabled={busy.startsWith(page.id)} onClick={() => void checkPage(page)}><RefreshCw size={15}/>ตรวจใหม่</button>{page.health !== "disconnected" ? <button className="is-danger" type="button" disabled={busy.startsWith(page.id)} onClick={() => void disconnectPage(page)}><Unplug size={15}/>ยกเลิกการเชื่อมต่อ</button> : null}</div> : null}</article>) : <div className="ops-empty"><ShieldCheck size={24}/><div><strong>ยังไม่ได้เชื่อมต่อ Facebook Page</strong><p>ผู้ดูแลระบบสามารถเริ่ม OAuth ของ Meta โดยไม่เก็บรหัสผ่าน Facebook ในระบบ</p></div>{data.actorRole === "admin" ? <button className="ops-button ops-button--primary" type="button" onClick={() => void connectPage()}>เชื่อมต่อ Facebook Page</button> : null}</div>}
      </section>
      <section className="ops-section" aria-labelledby="group-source-title"><div className="ops-section__head"><div><span className="ops-section__icon"><MessagesSquare size={18}/></span><div><h2 id="group-source-title">Facebook Groups</h2><p>ลิงก์ถาวรหลายกลุ่ม โหมดแยกต่อแหล่ง และหลักฐานการสแกนล่าสุด</p></div></div><span className="ops-count">{data.groups.length} กลุ่ม</span></div>
        <div className="source-list">{loading ? <div className="ops-skeleton">กำลังโหลดกลุ่ม…</div> : data.groups.length ? data.groups.map((source) => <SourceRow key={source.id} source={source} role={data.actorRole} busy={busy} expanded={expanded === source.id} browserHealth={browserHealth[source.id]} operationIssue={operationIssues[source.latestOperation?.operationId]} recoveryReady={recoveryReady.includes(source.id)} onMode={setMode} onSchedule={setSchedule} onScan={scan} onRetry={retryOperation} onInspect={inspect} onRecovery={beginRecovery} onResume={resumeAfterRecovery}/>) : <div className="ops-empty"><Plus size={24}/><div><strong>เพิ่มกลุ่มแรกเพื่อเริ่มสแกน</strong><p>ระบบรับเฉพาะลิงก์กลุ่มแบบตัวเลขและเปลี่ยนเป็น canonical URL ให้อัตโนมัติ</p></div></div>}</div>
      </section>
    </div>
    {addOpen ? <div className="ops-dialog-backdrop"><form className="ops-dialog" role="dialog" aria-modal="true" aria-labelledby="add-group-title" onSubmit={addGroup}><button className="ops-dialog__close" type="button" aria-label="ปิด" onClick={() => { setAddOpen(false); setFormError(""); }}><X size={18}/></button><span className="ops-dialog__eyebrow">New source</span><h2 id="add-group-title">เพิ่ม Facebook Group</h2><p>วางลิงก์กลุ่มที่ทีมของคุณได้รับอนุญาตให้ติดตาม ระบบจะบันทึกเป็นลิงก์ถาวรให้</p><label>ลิงก์ Facebook Group<input aria-label="ลิงก์ Facebook Group" autoFocus value={groupUrl} onChange={(event) => setGroupUrl(event.target.value)} placeholder="https://www.facebook.com/groups/1742522453522327"/></label>{formError ? <div className="ops-field-error" role="alert">{formError}</div> : null}<footer><button className="ops-button ops-button--secondary" type="button" onClick={() => setAddOpen(false)}>ยกเลิก</button><button className="ops-button ops-button--primary" disabled={busy === "add"}>ยืนยันเพิ่มกลุ่ม</button></footer></form></div> : null}
    {pagePicker ? <div className="ops-dialog-backdrop"><section className="ops-dialog page-picker" role="dialog" aria-modal="true" aria-labelledby="page-picker-title"><button className="ops-dialog__close" type="button" aria-label="ปิด" onClick={() => setPagePicker(null)}><X size={18}/></button><span className="ops-dialog__eyebrow">Messenger access</span><h2 id="page-picker-title">เลือก Facebook Page</h2><p>เลือกเพจที่ต้องการรับข้อความและตอบผ่าน rendar</p><div className="page-picker__list">{pagePicker.pages.length ? pagePicker.pages.map((page) => <button type="button" key={page.id} disabled={busy === "page-select"} onClick={() => void selectPage(page.id)}><span className="page-source-row__mark"><MessagesSquare size={18}/></span><span><strong>{page.name}</strong><small>Page ID {page.id}</small></span><CheckCircle2 size={18}/></button>) : <div className="ops-empty"><AlertTriangle size={22}/><div><strong>ไม่พบเพจที่มีสิทธิ์ Messenger</strong><p>ตรวจสอบบทบาทในเพจและสิทธิ์ที่อนุญาตให้แอป</p></div></div>}</div></section></div> : null}
    {recovery ? <BrowserRecovery recovery={recovery} busy={busy === `${recovery.sourceId}:resume`} onClose={closeRecovery} onResume={() => resumeAfterRecovery(data.groups.find((source) => source.id === recovery.sourceId))}/> : null}
  </div>;
}
