import { useState } from "react";
import { Check, CheckCircle2, CircleAlert, Clipboard, KeyRound, RadioTower, ServerCog } from "lucide-react";

export function Readiness({ value }) {
  const [copied, setCopied] = useState(false);
  const integrations = Array.isArray(value?.integrations) ? value.integrations : [
    { id: "database", label: "Database", status: value?.databaseConfigured ? "configured" : "missing" },
    { id: "openai", label: "OpenAI", status: value?.openaiConfigured ? "configured" : "missing" },
    { id: "messenger", label: "Messenger", status: value?.messengerConfigured ? "configured" : "missing" },
  ];
  const metaPoc = value?.metaPoc;
  const callbackUrl = metaPoc?.callbackUrl;
  const verificationReady = Boolean(callbackUrl && metaPoc?.verifyTokenConfigured);
  const deliveryReady = Boolean(verificationReady && metaPoc?.appSecretConfigured && metaPoc?.pageAccessTokenConfigured && metaPoc?.externalDeliveryEnabled);
  async function copyCallback() {
    if (!callbackUrl) return;
    await navigator.clipboard.writeText(callbackUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }
  return <section className="settings-panel readiness-panel" aria-labelledby="readiness-title">
    <header className="settings-panel__head"><span className="settings-panel__icon"><ServerCog size={18}/></span><div><h2 id="readiness-title">ความพร้อมระบบ</h2><p>สถานะการตั้งค่าโดยไม่อ่านค่าลับกลับมา</p></div></header>
    {metaPoc ? <div className="meta-poc" aria-label="Meta Messenger POC">
      <div className="meta-poc__heading"><span><RadioTower size={17}/></span><div><strong>Meta Messenger POC</strong><small>{metaPoc.mode === "fixture" ? "โหมดสาธิต · ยังไม่ส่งข้อความจริง" : "Production runtime"}</small></div><b className={callbackUrl ? "is-online" : ""}>{callbackUrl ? "Tunnel online" : "Tunnel offline"}</b></div>
      <div className="meta-poc__callback">
        <span>Callback URL</span>
        {callbackUrl ? <div><code>{callbackUrl}</code><button type="button" onClick={copyCallback} aria-label="คัดลอก Callback URL">{copied ? <Check size={15}/> : <Clipboard size={15}/>}<span>{copied ? "คัดลอกแล้ว" : "คัดลอก"}</span></button></div> : <p>ยังไม่ได้เปิด temporary HTTPS tunnel</p>}
      </div>
      <ul className="meta-poc__checks">
        <li className={callbackUrl ? "is-ready" : ""}><span>{callbackUrl ? <Check size={13}/> : "1"}</span><div><strong>HTTPS tunnel</strong><small>เปิดเฉพาะ /webhooks/meta</small></div></li>
        <li className={verificationReady ? "is-ready" : ""}><span>{verificationReady ? <Check size={13}/> : "2"}</span><div><strong>Webhook verification</strong><small>{verificationReady ? "พร้อม Verify and save" : "ต้องมี verify token"}</small></div></li>
        <li className={deliveryReady ? "is-ready" : ""}><span>{deliveryReady ? <Check size={13}/> : "3"}</span><div><strong>รับและส่งจริง</strong><small>{deliveryReady ? "พร้อมใช้งาน" : "ต้องมี App secret, Page token และเปิด live submission"}</small></div></li>
      </ul>
    </div> : null}
    <ul className="readiness-list">{integrations.map((item) => {
      const configured = item.status === "configured";
      return <li key={item.id} className={configured ? "is-ready" : "is-missing"}>{configured ? <CheckCircle2 size={18}/> : <CircleAlert size={18}/>}<div><strong>{item.label} {configured ? "configured" : "missing"}</strong>{!configured && item.missing?.length ? <span>{item.missing.join(" · ")}</span> : <span>{configured ? "พร้อมใช้งาน" : "ต้องตั้งค่าก่อนเปิดใช้งาน"}</span>}</div></li>;
    })}</ul>
    <div className="readiness-guidance"><KeyRound size={17}/><div><strong>Secret ไม่ถูกแสดงย้อนกลับ</strong><span>OpenAI key เปลี่ยนได้จากแผง OpenAI ในหน้านี้ ส่วน Meta App secret และ webhook token จัดการผ่าน deployment secret manager</span></div></div>
  </section>;
}
