const terminalReceiptStates = new Set(["completed"]);
const activeOperationStates = new Set(["pending", "queued", "running", "attempting"]);

const reasonCopy = {
  WORKER_FAILED: "worker สแกนไม่สำเร็จ",
  scan_failed: "Facebook ตอบกลับผิดพลาด",
  scan_timeout: "Facebook ใช้เวลาตอบกลับนานเกินไป",
  session_unavailable: "ไม่พบ Facebook session ที่พร้อมใช้งาน",
  session_lost: "Facebook session หลุดระหว่างสแกน",
  selector_changed: "โครงสร้างหน้า Facebook เปลี่ยน",
  identity_missing: "ตรวจสอบบัญชี Facebook ที่ใช้งานไม่ได้",
  identity_ambiguous: "พบบัญชี Facebook มากกว่าหนึ่งรายการ",
  scan_limit: "ถึงขีดจำกัดข้อมูลของรอบนี้",
  page_changed: "หน้า Facebook เปลี่ยนระหว่างสแกน",
  scan_cancelled: "รอบสแกนถูกยกเลิก",
};

export function sourceReadiness(source) {
  const circuitOpen = Boolean(source.health.sessionCircuit || source.health.selectorCircuit);
  const healthy = source.health.session === "healthy" && source.health.selector === "healthy" && !circuitOpen;
  if (source.paused) return { state: "paused", tone: "warn", label: "พักการทำงาน", detail: "ระบบจะไม่รับงานใหม่จนกว่าจะเปิดใช้งานอีกครั้ง" };
  if (healthy) return { state: "ready", tone: "good", label: "พร้อมสแกน", detail: "Facebook session และตัวอ่านโพสต์พร้อมใช้งาน" };
  if (source.health.session === "auth_required" || source.health.sessionCircuit) return { state: "recovery", tone: "bad", label: "ต้องเข้าสู่ระบบใหม่", detail: "เปิดหน้ากู้คืน Facebook session ก่อนสแกนต่อ" };
  return { state: "blocked", tone: "warn", label: "ต้องตรวจสอบการเชื่อมต่อ", detail: "ตรวจ session และโครงสร้างหน้า Facebook ก่อนสแกน" };
}

export function scanPresentation(source) {
  const operation = source.latestOperation;
  const receipt = source.latestReceipt;
  if (operation && !terminalReceiptStates.has(operation.state)) {
    if (activeOperationStates.has(operation.state)) return {
      state: operation.state,
      tone: "warn",
      label: operation.state === "running" || operation.state === "attempting" ? "กำลังสแกน Facebook" : "อยู่ในคิวสแกน",
      detail: operation.state === "running" || operation.state === "attempting" ? `worker รับงานแล้ว · ครั้งที่ ${Math.max(1, operation.attempts || 1)}` : "ระบบจะอัปเดตผลให้อัตโนมัติ",
    };
    if (operation.state === "failed") return { state: "failed", tone: "bad", label: "สแกนไม่สำเร็จ", detail: reasonCopy[operation.reason] ?? "worker ทำงานไม่สำเร็จ สามารถลองสแกนใหม่ได้" };
    if (operation.state === "stuck") return { state: "stuck", tone: "bad", label: "งานสแกนค้าง", detail: "งานไม่จบภายใน 10 นาที กรุณาลองสร้างรอบใหม่" };
    if (operation.state === "awaiting_result") return { state: "awaiting_result", tone: "warn", label: "กำลังบันทึกผลสแกน", detail: "worker ทำงานเสร็จแล้ว ระบบกำลังรอหลักฐานผลลัพธ์" };
  }
  if (!receipt) return { state: "never", tone: "muted", label: "ยังไม่เคยสแกน", detail: "กดสแกนครั้งแรกเพื่อตรวจชื่อกลุ่ม โพสต์ และความคิดเห็น" };
  const count = Number.isInteger(receipt.acceptedCount) ? receipt.acceptedCount : null;
  const coverage = receipt.coverage === "complete" ? "ครบ" : receipt.coverage === "partial" ? "บางส่วน" : "ไม่พบข้อมูล";
  const reason = receipt.reason ? reasonCopy[receipt.reason] ?? receipt.reason : null;
  return {
    state: receipt.health === "healthy" ? "completed" : "completed_with_issue",
    tone: receipt.health === "healthy" ? receipt.coverage === "complete" ? "good" : "warn" : "bad",
    label: receipt.health === "healthy" ? "สแกนล่าสุดเสร็จแล้ว" : "สแกนล่าสุดต้องตรวจสอบ",
    detail: [`ครอบคลุม${coverage}`, count == null ? null : `พบ ${count} รายการ`, reason].filter(Boolean).join(" · "),
  };
}

export function primarySourceAction(source, { recoveryReady = false } = {}) {
  const readiness = sourceReadiness(source);
  const scan = scanPresentation(source);
  if (recoveryReady && source.paused) return { id: "resume", label: "ยืนยันและสแกนทดสอบ", disabled: false };
  if (activeOperationStates.has(scan.state) || scan.state === "awaiting_result") return { id: "progress", label: scan.label, disabled: true };
  if (readiness.state === "recovery" || readiness.state === "blocked") return { id: "recover", label: "กู้คืนการเชื่อมต่อ", disabled: false };
  if (source.paused) return { id: "paused", label: "แหล่งข้อมูลถูกพัก", disabled: true };
  if (scan.state === "failed" || scan.state === "stuck") return { id: "scan", label: "ลองสแกนใหม่", disabled: false };
  return { id: "scan", label: "สแกนตอนนี้", disabled: false };
}

export function reasonLabel(reason) {
  return reasonCopy[reason] ?? reason ?? "—";
}
