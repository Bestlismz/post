import { CheckCircle2, CircleAlert, KeyRound, ServerCog } from "lucide-react";

export function Readiness({ value }) {
  const integrations = Array.isArray(value?.integrations) ? value.integrations : [
    { id: "database", label: "Database", status: value?.databaseConfigured ? "configured" : "missing" },
    { id: "openai", label: "OpenAI", status: value?.openaiConfigured ? "configured" : "missing" },
    { id: "messenger", label: "Messenger", status: value?.messengerConfigured ? "configured" : "missing" },
  ];
  return <section className="settings-panel readiness-panel" aria-labelledby="readiness-title">
    <header className="settings-panel__head"><span className="settings-panel__icon"><ServerCog size={18}/></span><div><h2 id="readiness-title">ความพร้อมระบบ</h2><p>สถานะการตั้งค่าโดยไม่อ่านค่าลับกลับมา</p></div></header>
    <ul className="readiness-list">{integrations.map((item) => {
      const configured = item.status === "configured";
      return <li key={item.id} className={configured ? "is-ready" : "is-missing"}>{configured ? <CheckCircle2 size={18}/> : <CircleAlert size={18}/>}<div><strong>{item.label} {configured ? "configured" : "missing"}</strong>{!configured && item.missing?.length ? <span>{item.missing.join(" · ")}</span> : <span>{configured ? "พร้อมใช้งาน" : "ต้องตั้งค่าก่อนเปิดใช้งาน"}</span>}</div></li>;
    })}</ul>
    <div className="readiness-guidance"><KeyRound size={17}/><div><strong>เปลี่ยน secret ผ่าน deployment environment</strong><span>อัปเดต secret manager หรือไฟล์ environment ของ deployment แล้ว restart runtime ที่เกี่ยวข้อง — ค่าลับจะไม่ถูกแสดงย้อนกลับ</span></div></div>
  </section>;
}
