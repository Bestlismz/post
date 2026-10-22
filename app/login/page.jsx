"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LockKeyhole, Radar } from "lucide-react";
import { api } from "../lib/api-client.mjs";
import "./login.css";

const destinations = new Set(["/inbox", "/properties", "/sources", "/automations", "/settings"]);
function safeDestination(value) { return destinations.has(value) ? value : "/inbox"; }

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState(""), [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function submit(event) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      await api.request("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
      router.replace(safeDestination(new URLSearchParams(window.location.search).get("next"))); router.refresh();
    } catch (caught) { setError(caught.status === 401 ? "อีเมลหรือรหัสผ่านไม่ถูกต้อง" : caught.message); }
    finally { setBusy(false); }
  }
  return <main className="login-page"><section className="login-story" aria-label="Rental Radar"><div className="login-brand"><span>R</span>Rental Radar</div><div><p className="login-eyebrow">Rental operations</p><h1>เปลี่ยนทุกบทสนทนา<br/>ให้เป็นโอกาสเช่า</h1><p>รวมลีดจาก Facebook Page และ Group จับคู่กับห้องว่าง และส่งต่อให้ทีมดูแลในพื้นที่ทำงานเดียว</p></div><div className="login-proof"><Radar size={20}/><span>ข้อมูลห้อง การตอบกลับ และหลักฐานการทำงานอยู่ในระบบเดียว</span></div></section><section className="login-panel"><form className="login-card" onSubmit={submit}><span className="login-card__icon"><LockKeyhole size={22}/></span><p className="login-eyebrow">สำหรับทีมงาน</p><h2>เข้าสู่ Rental Radar</h2><p className="login-card__intro">ใช้บัญชีที่ผู้ดูแลสร้างให้ แล้วเชื่อมต่อ Facebook ในหน้า Sources</p><label>อีเมล<input type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@company.com"/></label><label>รหัสผ่าน<input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} placeholder="รหัสผ่านของบัญชีแอป"/></label>{error ? <div className="login-error" role="alert">{error}</div> : null}<button type="submit" disabled={busy}>{busy ? "กำลังเข้าสู่ระบบ…" : "เข้าสู่ระบบ"}</button><small>ระบบจะไม่ขอหรือบันทึกรหัสผ่าน Facebook ของคุณ</small></form></section></main>;
}
