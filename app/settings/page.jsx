"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Database, History, RefreshCw, ShieldCheck } from "lucide-react";
import { api } from "../lib/api-client.mjs";
import { AuditView } from "./audit-view";
import { BusinessProfile } from "./business-profile";
import { Readiness } from "./readiness";
import { UsersPanel } from "./users-panel";
import "./settings.css";

const key = () => globalThis.crypto?.randomUUID?.() ?? `settings-${Date.now()}-${Math.random()}`;

function RetentionPanel({ value, busy, onSave }) {
  const [form, setForm] = useState(value);
  const [error, setError] = useState("");
  useEffect(() => setForm(value), [value]);
  function update(field, next) { setForm((current) => ({ ...current, [field]: next })); setError(""); }
  async function submit(event) {
    event.preventDefault();
    const rawPayloadDays = Number(form.rawPayloadDays), screenshotDays = Number(form.screenshotDays);
    if (![rawPayloadDays, screenshotDays].every((days) => Number.isInteger(days) && days >= 1 && days <= 3650)) {
      setError("กรุณาระบุ 1–3,650 วัน"); return;
    }
    await onSave({ rawPayloadDays, screenshotDays });
  }
  return <section className="settings-panel retention-panel" aria-labelledby="retention-title">
    <header className="settings-panel__head"><span className="settings-panel__icon"><Database size={18}/></span><div><h2 id="retention-title">การเก็บรักษาข้อมูล</h2><p>กำหนดอายุหลักฐานโดยไม่ลบ audit ledger</p></div></header>
    <form className="settings-form settings-form--compact" onSubmit={submit} noValidate>
      <label><span>เก็บ payload ดิบ (วัน)</span><input aria-label="เก็บ payload ดิบ (วัน)" inputMode="numeric" min="1" max="3650" value={form.rawPayloadDays ?? ""} onChange={(event) => update("rawPayloadDays", event.target.value)}/></label>
      <label><span>เก็บภาพหลักฐาน (วัน)</span><input aria-label="เก็บภาพหลักฐาน (วัน)" inputMode="numeric" min="1" max="3650" value={form.screenshotDays ?? ""} onChange={(event) => update("screenshotDays", event.target.value)}/></label>
      {error ? <p className="settings-field-error" role="alert">{error}</p> : null}
      <footer><button className="settings-button settings-button--primary" disabled={busy} type="submit">{busy ? "กำลังบันทึก…" : "บันทึกระยะเวลา"}</button></footer>
    </form>
  </section>;
}

export default function SettingsPage() {
  const [actor, setActor] = useState(null);
  const [data, setData] = useState({ users: [], profile: null, retention: null, readiness: null });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const csrfRef = useRef("");

  const load = useCallback(async () => {
    setLoading(true); setLoadError("");
    try {
      const identity = await api.request("/api/me");
      const user = identity.user;
      setActor(user);
      if (user?.role !== "admin") return;
      const [users, profile, retention, readiness] = await Promise.all([
        api.request("/api/settings/users"), api.request("/api/settings/business-profile"),
        api.request("/api/settings/retention"), api.request("/api/settings/readiness"),
      ]);
      setData({ users: users.users ?? [], profile, retention, readiness });
    } catch (error) { setLoadError(error.message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function csrf(force = false) {
    if (!force && csrfRef.current) return csrfRef.current;
    const result = await api.request("/api/auth/csrf", { method: "POST" });
    csrfRef.current = result.csrfToken;
    return csrfRef.current;
  }
  async function mutate(path, body, revision) {
    const requestKey = key();
    const send = async (token) => api.request(path, { method: "PATCH", headers: { "X-CSRF-Token": token, "Idempotency-Key": requestKey, "If-Match": `"${revision}"` }, body: JSON.stringify(body) });
    let token = await csrf();
    try { return await send(token); }
    catch (error) { if (error.status !== 403) throw error; token = await csrf(true); return send(token); }
  }
  async function run(name, operation, success) {
    setBusy(name); setNotice("");
    try { const result = await operation(); setNotice(success); return result; }
    catch (error) { setNotice(error.status === 409 ? "ข้อมูลถูกแก้ไขจากอีกหน้าต่าง กรุณาโหลดใหม่" : error.message); return null; }
    finally { setBusy(""); }
  }
  async function changeRole(user, role) {
    const saved = await run(`role:${user.id}`, () => mutate(`/api/settings/users/${user.id}`, { role }, user.revision), "อัปเดตสิทธิ์แล้ว");
    if (saved) setData((current) => ({ ...current, users: current.users.map((entry) => entry.id === user.id ? { ...entry, ...saved } : entry) }));
  }
  async function saveProfile(input) {
    const saved = await run("profile", () => mutate("/api/settings/business-profile", input, data.profile.revision), "บันทึกข้อมูลธุรกิจแล้ว");
    if (saved) setData((current) => ({ ...current, profile: saved }));
  }
  async function saveRetention(input) {
    const saved = await run("retention", () => mutate("/api/settings/retention", input, data.retention.revision), "บันทึกระยะเวลาการเก็บข้อมูลแล้ว");
    if (saved) setData((current) => ({ ...current, retention: saved }));
  }

  if (loading) return <div className="settings-loading" aria-live="polite"><span/><p>กำลังโหลดการตั้งค่า…</p></div>;
  if (loadError || !actor) return <div className="settings-access settings-access--error"><span><AlertTriangle size={24}/></span><h1>โหลดการตั้งค่าไม่สำเร็จ</h1><div>{loadError}</div><button className="settings-button" onClick={load}><RefreshCw size={16}/>ลองอีกครั้ง</button></div>;
  if (actor.role !== "admin") return <div className="settings-access"><span><ShieldCheck size={24}/></span><p>Admin only</p><h1>การตั้งค่าสำหรับผู้ดูแลระบบ</h1><div>บัญชีของคุณยังไม่มีสิทธิ์เปลี่ยนผู้ใช้ การเก็บข้อมูล หรือการเชื่อมต่อ</div><small>ข้อมูลกิจกรรมของรายการยังดูได้จาก Inbox</small></div>;
  if (!data.profile) return <div className="settings-access settings-access--error"><span><AlertTriangle size={24}/></span><h1>โหลดการตั้งค่าไม่สำเร็จ</h1><div>ข้อมูลการตั้งค่าไม่ครบถ้วน</div><button className="settings-button" onClick={load}><RefreshCw size={16}/>ลองอีกครั้ง</button></div>;

  return <div className="settings-page">
    <header className="settings-heading"><div><p>Administration</p><h1>การตั้งค่าระบบ</h1><span>ดูแลทีม ข้อมูลธุรกิจ ความปลอดภัย และหลักฐานจากที่เดียว</span></div><div className="settings-heading__role"><ShieldCheck size={17}/><span>Admin workspace</span></div></header>
    {notice ? <div className="settings-notice" role="status"><ShieldCheck size={16}/><span>{notice}</span></div> : null}
    <div className="settings-grid">
      <BusinessProfile value={data.profile} busy={busy === "profile"} onSave={saveProfile}/>
      <Readiness value={data.readiness}/>
      <UsersPanel users={data.users} currentUserId={actor.id} busy={busy} onRoleChange={changeRole}/>
      <RetentionPanel value={data.retention} busy={busy === "retention"} onSave={saveRetention}/>
      <AuditView />
    </div>
    <aside className="settings-context-note"><History size={17}/><span>Activity history ของโพสต์ ข้อความ และการส่งตอบยังอยู่ในบริบทของแต่ละรายการใน Inbox ส่วนหน้านี้คือ audit ledger ทั้งระบบ</span></aside>
  </div>;
}
