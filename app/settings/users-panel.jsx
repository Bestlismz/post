import { Shield, UsersRound } from "lucide-react";

const roles = [["admin", "ผู้ดูแลระบบ"], ["operator", "เจ้าหน้าที่ตอบกลับ"], ["inventory_manager", "ผู้จัดการห้อง"], ["viewer", "ดูอย่างเดียว"]];

export function UsersPanel({ users, currentUserId, busy, onRoleChange }) {
  return <section className="settings-panel settings-panel--wide" aria-labelledby="users-title">
    <header className="settings-panel__head"><span className="settings-panel__icon"><UsersRound size={18}/></span><div><h2 id="users-title">ทีมและสิทธิ์</h2><p>{users.length} บัญชีที่เข้าถึงองค์กรนี้</p></div></header>
    <div className="settings-users" role="list">{users.map((user) => <article className="settings-user" role="listitem" key={user.id}>
      <span className="settings-user__avatar" aria-hidden="true">{user.displayName?.slice(0, 1) ?? user.email.slice(0, 1).toUpperCase()}</span>
      <div className="settings-user__identity"><strong>{user.displayName}</strong><span>{user.email}</span></div>
      <label className="settings-user__role"><span className="rr-sr-only">สิทธิ์ของ {user.displayName}</span><Shield size={15}/><select aria-label={`สิทธิ์ของ ${user.displayName}`} disabled={busy === `role:${user.id}` || user.id === currentUserId} value={user.role} onChange={(event) => onRoleChange(user, event.target.value)}>{roles.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    </article>)}</div>
  </section>;
}
