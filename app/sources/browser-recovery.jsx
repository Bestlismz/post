import { LockKeyhole, X } from "lucide-react";

export function BrowserRecovery({ recovery, onClose }) {
  return <div className="recovery-backdrop"><section className="recovery-panel" role="dialog" aria-modal="true" aria-labelledby="recovery-title"><header><div><span><LockKeyhole size={18}/></span><div><h2 id="recovery-title">กู้คืน Facebook session</h2><p>หน้าต่างส่วนตัว · หมดอายุ {new Intl.DateTimeFormat("th-TH", { timeStyle: "short", timeZone: "Asia/Bangkok" }).format(new Date(recovery.expiresAt))}</p></div></div><button type="button" aria-label="ปิดหน้ากู้คืน" onClick={onClose}><X size={20}/></button></header><div className="recovery-warning">กรอกรหัสผ่านและ checkpoint ด้วยตัวเอง ระบบ rendar จะไม่อ่านหรือบันทึกข้อมูลล็อกอิน</div><iframe title="Facebook session recovery" src={recovery.tunnelUrl}/></section></div>;
}
