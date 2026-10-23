import { Activity, AlertCircle, CheckCircle2, ChevronDown, Clock3, ExternalLink, LockKeyhole, RefreshCw, ScanSearch } from "lucide-react";
import { primarySourceAction, reasonLabel, scanPresentation, sourceReadiness } from "./source-presentation.mjs";

const modeCopy = {
  observe: { title: "Observe", description: "เก็บงานเข้า Inbox เท่านั้น" },
  approval: { title: "Approval", description: "เตรียมคำตอบและรอคนอนุมัติ" },
  automatic: { title: "Automatic", description: "ตอบได้เมื่อผ่านกติกาความปลอดภัยทุกข้อ" },
};

const formatTime = (value) => value ? new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bangkok" }).format(new Date(value)) : "—";

export function SourceRow({ source, role, busy, expanded, browserHealth, operationIssue, recoveryReady, onMode, onSchedule, onScan, onRetry, onInspect, onRecovery, onResume }) {
  const readiness = sourceReadiness(source);
  const scan = scanPresentation(source);
  const action = primarySourceAction(source, { recoveryReady });
  const accessLabel = source.accessLevel === "admin" ? "แอดมินกลุ่ม" : source.accessLevel === "reader" ? "อ่านได้ · ไม่ใช่แอดมิน" : "รอตรวจสอบสิทธิ์";
  const working = busy.startsWith(`${source.id}:`);
  const runPrimary = () => {
    if (action.id === "recover") return onRecovery(source);
    if (action.id === "resume") return onResume(source);
    if (action.id === "scan") return onScan(source, { recovery: source.health.sessionCircuit || source.health.selectorCircuit });
  };

  return <article className={`source-row${expanded ? " is-expanded" : ""}`} data-testid={`source-${source.id}`}>
    <div className="source-row__main">
      <span className={`source-health-orb${readiness.tone !== "good" ? " is-warning" : ""}`}>{readiness.tone === "good" ? <CheckCircle2 size={19}/> : <AlertCircle size={19}/>}</span>
      <div className="source-identity"><strong>{source.displayName || "กำลังรอชื่อกลุ่มจาก Facebook"}</strong><div className="source-identity__meta"><span className={`source-access source-access--${source.accessLevel || "unknown"}`}>{accessLabel}</span><a href={source.canonicalUrl} target="_blank" rel="noreferrer">เปิดกลุ่ม <ExternalLink size={13}/></a></div><small>{source.canonicalUrl}</small></div>
      <div className="source-mode-block"><span>โหมดตอบกลับ</span><div className="source-mode" aria-label="โหมดตอบกลับ">{Object.entries(modeCopy).map(([mode, copy]) => <button key={mode} className={source.mode === mode ? "is-active" : ""} type="button" aria-pressed={source.mode === mode} title={copy.description} disabled={busy === `${source.id}:mode` || role !== "admin"} onClick={() => onMode(source, mode)}>{copy.title}</button>)}</div><small>{modeCopy[source.mode]?.description}</small></div>
      <div className="source-actions"><button className="ops-button ops-button--primary" type="button" disabled={working || action.disabled} onClick={runPrimary}>{action.id === "recover" ? <LockKeyhole size={16}/> : action.id === "progress" ? <RefreshCw className="is-spinning" size={16}/> : <ScanSearch size={16}/>} {action.label}</button><button className="ops-icon-button" type="button" aria-label="ดูรายละเอียดการสแกน" aria-expanded={expanded} onClick={() => onInspect(source)}><ChevronDown size={18}/></button></div>
    </div>
    <div className="source-run-summary">
      <div className={`source-run-state source-run-state--${operationIssue?.state === "retry_required" ? "bad" : scan.tone}`}><i/><span><strong>{operationIssue?.state === "retry_required" ? "ตรวจสถานะล่าสุดไม่ได้" : scan.label}</strong><small>{operationIssue?.state === "retry_required" ? "การสแกนอาจยังทำงานอยู่ ลองโหลดสถานะอีกครั้ง" : scan.detail}</small></span></div>
      {operationIssue?.state === "retry_required" ? <button className="receipt-retry" type="button" onClick={() => onRetry(source)}><RefreshCw size={14}/>โหลดสถานะ</button> : null}
      <div className={`source-readiness source-readiness--${readiness.tone}`}><span>การเชื่อมต่อ</span><strong>{readiness.label}</strong><small>{readiness.detail}</small></div>
      <div className="source-next-run"><span>ระบบตรวจตารางรอบถัดไป</span><strong>{source.nextScheduleCheckWithinMinutes ? `ไม่เกิน ${source.nextScheduleCheckWithinMinutes} นาที` : "ปิดอยู่"}</strong><label className="source-cadence"><Clock3 size={14}/><select aria-label={`รอบสแกน ${source.displayName || source.canonicalUrl}`} value={source.schedule?.cadenceMinutes ?? 15} disabled={role !== "admin" || busy === `${source.id}:schedule`} onChange={(event) => onSchedule(source, Number(event.target.value))}><option value="5">ทุก 5 นาที</option><option value="15">ทุก 15 นาที</option><option value="30">ทุก 30 นาที</option><option value="60">ทุก 60 นาที</option></select></label></div>
    </div>
    {expanded ? <div className="source-row__details"><div className="source-detail-grid"><div><span>รอบล่าสุด</span><strong>{formatTime(source.latestReceipt?.createdAt || source.latestOperation?.updatedAt || source.latestOperation?.createdAt)}</strong><p>{source.latestOperation?.jobState ? `สถานะ worker: ${source.latestOperation.jobState}` : "ยังไม่มีงานจาก worker"}</p></div><div><span>ความครอบคลุม</span><strong>{source.latestReceipt?.coverage ?? "—"} · {source.latestReceipt?.acceptedCount ?? "—"} รายการ</strong><p>{source.latestReceipt?.reason ? reasonLabel(source.latestReceipt.reason) : "ไม่มีเหตุขัดข้องที่รายงาน"}</p></div><div><span>รอบตามตารางล่าสุด</span><strong>{source.latestSchedule?.state ?? "—"}</strong><p>{source.latestSchedule?.reasons?.length ? source.latestSchedule.reasons.map(reasonLabel).join(", ") : source.latestSchedule?.jobState ? `สถานะ worker: ${source.latestSchedule.jobState}` : "รอตารางรอบแรก"}</p></div></div>{browserHealth?.error ? <p className="inline-error">{browserHealth.error}</p> : null}<div className="source-recovery-action"><div><Activity size={17}/><span><strong>Facebook browser session</strong><small>Session: {browserHealth?.sourceHealth?.session ?? source.health.session} · Selector: {source.health.selector} · เจ้าของ session: group-worker</small></span></div>{role === "admin" && action.id !== "recover" ? <button className="ops-button ops-button--secondary" type="button" disabled={busy === `${source.id}:recovery`} onClick={() => onRecovery(source)}><RefreshCw size={16}/>เปิดหน้ากู้คืนเซสชัน</button> : role !== "admin" ? <p>เฉพาะผู้ดูแลระบบเท่านั้นที่เปิดหน้ากู้คืนได้</p> : null}</div></div> : null}
  </article>;
}
