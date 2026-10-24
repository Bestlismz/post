"use client";

import { Bot, Save, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

const splitPhrases = (value) => value.split(",").map((item) => item.trim()).filter(Boolean);

export function AgentReplyPanel({ value, busy, onSave }) {
  const [form, setForm] = useState(value);
  const [forbidden, setForbidden] = useState((value.forbiddenPhrases ?? []).join(", "));
  const [error, setError] = useState("");
  useEffect(() => {
    setForm(value);
    setForbidden((value.forbiddenPhrases ?? []).join(", "));
  }, [value]);
  const update = (field, next) => {
    setForm((current) => ({
      ...current,
      [field]: next,
      ...(field === "tone" && next === "formal" ? { emojiPolicy: "none" } : {}),
    }));
    setError("");
  };
  const characterCount = useMemo(() => [...(form.agentInstructions ?? "")].length, [form.agentInstructions]);
  async function submit(event) {
    event.preventDefault();
    const agentInstructions = form.agentInstructions.trim();
    if (agentInstructions.length < 20) {
      setError("กรุณาระบุแนวทางอย่างน้อย 20 ตัวอักษร");
      return;
    }
    await onSave({ ...form, agentInstructions, forbiddenPhrases: splitPhrases(forbidden) });
  }
  return <section className="settings-panel settings-panel--wide agent-reply-panel" aria-labelledby="agent-reply-title">
    <header className="settings-panel__head">
      <span className="settings-panel__icon"><Bot size={19}/></span>
      <div><h2 id="agent-reply-title">แนวทางการตอบของ Agent</h2><p>กำหนดวิธีเลือกห้องและน้ำเสียงที่ใช้กับทั้ง Facebook Group และ Messenger</p></div>
      <span className="agent-reply-panel__status"><ShieldCheck size={15}/>อ้างอิงข้อมูลจริงเท่านั้น</span>
    </header>
    <form className="settings-form agent-reply-form" onSubmit={submit} noValidate>
      <label className="agent-reply-form__prompt"><span>คำสั่งสำหรับ Agent</span><textarea aria-label="คำสั่งสำหรับ Agent" rows="5" maxLength="4000" value={form.agentInstructions ?? ""} onChange={(event) => update("agentInstructions", event.target.value)}/><small>{characterCount.toLocaleString("th-TH")} / 4,000 · ใช้จัดลำดับห้องและเลือกวิธีตอบ แต่ราคาและรายละเอียดห้องยังดึงจาก PostgreSQL เท่านั้น</small></label>
      <div className="agent-reply-form__controls">
        <label><span>ภาษา</span><select value={form.locale} onChange={(event) => update("locale", event.target.value)}><option value="th">ไทย</option><option value="en">English</option></select></label>
        <label><span>น้ำเสียง</span><select value={form.tone} onChange={(event) => update("tone", event.target.value)}><option value="friendly">เป็นมิตร</option><option value="neutral">กระชับ เป็นกลาง</option><option value="formal">เป็นทางการ</option></select></label>
        <label><span>คำทักทาย</span><select value={form.greetingId} onChange={(event) => update("greetingId", event.target.value)}><option value="hello">มีคำทักทาย</option><option value="none">ไม่ใช้</option></select></label>
        <label><span>การถามต่อ</span><select value={form.ctaId} onChange={(event) => update("ctaId", event.target.value)}><option value="requirements">ถามเฉพาะข้อมูลที่ขาด</option><option value="follow_up">ขอติดต่อกลับ</option><option value="none">ไม่ใช้</option></select></label>
        <label><span>คำปิด</span><select value={form.closingId} onChange={(event) => update("closingId", event.target.value)}><option value="thanks">ขอบคุณ</option><option value="none">ไม่ใช้</option></select></label>
        <label><span>อีโมจิ</span><select value={form.emojiPolicy} disabled={form.tone === "formal"} onChange={(event) => update("emojiPolicy", event.target.value)}><option value="none">ไม่ใช้</option><option value="friendly">ใช้เล็กน้อย</option></select></label>
      </div>
      <label><span>คำที่ห้ามใช้</span><input value={forbidden} placeholder="เช่น การันตี, จองได้แน่นอน (คั่นด้วยจุลภาค)" onChange={(event) => { setForbidden(event.target.value); setError(""); }}/></label>
      <label className="settings-range"><span>ความยาวสูงสุด <b>{form.maxLength.toLocaleString("th-TH")} ตัวอักษร</b></span><input type="range" min="200" max="2000" step="100" value={form.maxLength} onChange={(event) => update("maxLength", Number(event.target.value))}/></label>
      {error ? <p className="settings-field-error" role="alert">{error}</p> : null}
      <footer><span className="agent-reply-form__note">คำตอบใหม่จะใช้ revision นี้ทันที ส่วนคำตอบที่ส่งแล้วจะไม่ถูกแก้ย้อนหลัง</span><button className="settings-button settings-button--primary" disabled={busy} type="submit"><Save size={16}/>{busy ? "กำลังบันทึก…" : "บันทึกแนวทางการตอบ"}</button></footer>
    </form>
  </section>;
}
