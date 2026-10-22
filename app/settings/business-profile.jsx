"use client";

import { Building2 } from "lucide-react";
import { useEffect, useState } from "react";

export function BusinessProfile({ value, busy, onSave }) {
  const [form, setForm] = useState(value);
  useEffect(() => setForm(value), [value]);
  const set = (field, next) => setForm((current) => ({ ...current, [field]: next }));
  return <section className="settings-panel settings-panel--profile" aria-labelledby="profile-title">
    <header className="settings-panel__head"><span className="settings-panel__icon"><Building2 size={18}/></span><div><h2 id="profile-title">ข้อมูลธุรกิจ</h2><p>บริบทที่ใช้วิเคราะห์ว่าลีดเกี่ยวข้องกับธุรกิจหรือไม่</p></div></header>
    <form className="settings-form" onSubmit={(event) => { event.preventDefault(); void onSave({ name: form.name.trim(), description: form.description.trim(), relevanceThreshold: Number(form.relevanceThreshold) }); }}>
      <label><span>ชื่อธุรกิจ</span><input aria-label="ชื่อธุรกิจ" required maxLength="200" value={form.name} onChange={(event) => set("name", event.target.value)}/></label>
      <label><span>บริการและลูกค้าเป้าหมาย</span><textarea aria-label="บริการและลูกค้าเป้าหมาย" required maxLength="10000" rows="4" value={form.description} onChange={(event) => set("description", event.target.value)}/></label>
      <label className="settings-range"><span>เกณฑ์ความเกี่ยวข้อง <b>{form.relevanceThreshold}</b></span><input aria-label="เกณฑ์ความเกี่ยวข้อง" type="range" min="0" max="100" value={form.relevanceThreshold} onChange={(event) => set("relevanceThreshold", event.target.value)}/></label>
      <footer><button className="settings-button settings-button--primary" disabled={busy} type="submit">{busy ? "กำลังบันทึก…" : "บันทึกข้อมูลธุรกิจ"}</button></footer>
    </form>
  </section>;
}
