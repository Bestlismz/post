"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, authExpiredEvent } from "../lib/api-client.mjs";
import { routeHref, routes } from "../lib/routes.mjs";
import { AppIcon } from "./icons";
import { BrandMark, BrandName } from "./brand";

const roleLabels = { admin: "ผู้ดูแลระบบ", operator: "เจ้าหน้าที่", inventory_manager: "ผู้จัดการข้อมูลห้อง", viewer: "ผู้ดูข้อมูล" };
function initials(value) { return (value || "RR").trim().slice(0, 2).toUpperCase(); }
function safeAvatar(value) { try { const url = new URL(value); return url.protocol === "https:" ? url.href : null; } catch { return null; } }

function Menu({ buttonRef, open, onClose, label, children, activeIndex = 0 }) {
  const menuRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const items = [...menuRef.current.querySelectorAll('[role^="menuitem"]')];
    items[Math.max(0, Math.min(activeIndex, items.length - 1))]?.focus();
    const closeOutside = (event) => { if (!menuRef.current.contains(event.target) && !buttonRef.current?.contains(event.target)) onClose(false); };
    const keys = (event) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(true); return; }
      if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return;
      event.preventDefault(); const current = Math.max(0, items.indexOf(document.activeElement));
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    };
    document.addEventListener("pointerdown", closeOutside); menuRef.current.addEventListener("keydown", keys);
    return () => { document.removeEventListener("pointerdown", closeOutside); menuRef.current?.removeEventListener("keydown", keys); };
  }, [activeIndex, buttonRef, onClose, open]);
  return open ? <div className="rr-menu" role="menu" aria-label={label} ref={menuRef}>{children}</div> : null;
}

export function AppShell({ children }) {
  const [session, setSession] = useState({ state: "loading", user: null, csrfToken: "", facebook: null });
  const [accountOpen, setAccountOpen] = useState(false);
  const pathname = usePathname(), router = useRouter();
  const accountButton = useRef(null);

  const publicRoute = pathname === "/login" || pathname === "/settings/meta/callback";
  useEffect(() => {
    if (publicRoute) return undefined;
    const signedOut = () => {
      const next = ["/inbox", "/properties", "/sources", "/settings"].includes(pathname) ? pathname : "/inbox";
      setSession((value) => ({ ...value, state: "signed_out", user: null }));
      router.replace(`/login?next=${encodeURIComponent(next)}`);
    };
    window.addEventListener(authExpiredEvent, signedOut);
    return () => window.removeEventListener(authExpiredEvent, signedOut);
  }, [pathname, publicRoute, router]);
  useEffect(() => {
    if (publicRoute) { setSession((value) => ({ ...value, state: "public" })); return undefined; }
    let cancelled = false;
    setSession((value) => ({ ...value, state: "loading" }));
    Promise.allSettled([api.request("/api/me"), api.request("/api/facebook/session-summary")]).then(([identity, facebook]) => {
      if (cancelled) return;
      if (identity.status === "rejected" && identity.reason?.status === 401) {
        const next = ["/inbox", "/properties", "/sources", "/settings"].includes(pathname) ? pathname : "/inbox";
        router.replace(`/login?next=${encodeURIComponent(next)}`);
        setSession((value) => ({ ...value, state: "signed_out", user: null }));
        return;
      }
      setSession({
        state: identity.status === "fulfilled" ? "signed_in" : "unavailable",
        user: identity.status === "fulfilled" ? identity.value?.user ?? null : null,
        csrfToken: "",
        facebook: facebook.status === "fulfilled" ? facebook.value : null,
      });
    });
    return () => { cancelled = true; };
  }, [pathname, publicRoute, router]);

  const active = routes.find((route) => route.path === pathname) ?? routes[0];
  const closeAccount = useCallback((restore) => { setAccountOpen(false); if (restore) requestAnimationFrame(() => accountButton.current?.focus()); }, []);
  const logout = async () => {
    const csrfToken = session.csrfToken || (await api.request("/api/auth/csrf", { method: "POST" }))?.csrfToken;
    if (!csrfToken) return;
    await api.request("/api/auth/logout", { method: "POST", headers: { "X-CSRF-Token": csrfToken }, body: "{}" });
    setSession((value) => ({ ...value, state: "signed_out", user: null, csrfToken: "" })); closeAccount(false); router.replace("/login");
  };
  const facebook = session.facebook, fbConnected = facebook?.state === "connected", fbName = fbConnected ? facebook?.identity?.displayName : null, avatar = safeAvatar(facebook?.identity?.avatarUrl);
  const facebookLabel = fbConnected
    ? fbName || (facebook.connections?.groups > 0 ? "เชื่อมต่อ Facebook Groups แล้ว" : "เชื่อมต่อ Facebook แล้ว")
    : facebook?.state === "reauth_required" ? "ต้องเข้าสู่ระบบ Facebook ใหม่" : "ยังไม่เชื่อมต่อ Facebook";

  if (publicRoute) return children;
  if (session.state === "unavailable") return <main className="rr-session-boundary"><span className="rr-session-boundary__mark"><BrandMark /></span><h1>เชื่อมต่อระบบไม่ได้</h1><p>กรุณาตรวจสอบการเชื่อมต่อแล้วลองใหม่</p><button type="button" onClick={() => window.location.reload()}>ลองอีกครั้ง</button></main>;
  if (session.state !== "signed_in") return <main className="rr-session-boundary" aria-label="กำลังตรวจสอบบัญชี"><span className="rr-session-boundary__mark"><BrandMark /></span><p>กำลังตรวจสอบบัญชี…</p></main>;

  return <div className="rr-shell">
    <header className="rr-topbar">
      <Link className="rr-brand" href="/inbox" aria-label="Naina · ไปที่ Inbox"><span className="rr-brand__mark"><BrandMark /></span><BrandName /></Link>
      <div className="rr-topbar__actions">
        <div className="rr-menu-anchor">
          <button className="rr-profile" type="button" ref={accountButton} aria-label="เปิดเมนูบัญชี" aria-haspopup="menu" aria-expanded={accountOpen} onClick={() => setAccountOpen((value) => !value)}>
            {avatar ? <img src={avatar} alt="" referrerPolicy="no-referrer" /> : <span>{initials(fbName || session.user?.displayName)}</span>}<b>{facebookLabel}</b><AppIcon name="chevronDown" size={16} />
          </button>
          <Menu buttonRef={accountButton} open={accountOpen} onClose={closeAccount} label="เมนูบัญชี">
            <div className="rr-menu__identity"><small>Facebook identity</small><strong>{facebookLabel}</strong><span>{facebook?.state === "reauth_required" ? "ต้องเข้าสู่ระบบ Facebook ใหม่" : fbConnected ? `Page ${facebook.connections?.pages ?? 0} · Group ${facebook.connections?.groups ?? 0}` : "ไม่มีเซสชันที่พร้อมใช้งาน"}</span></div>
            {session.user?.role === "inventory_manager"
              ? <div className="rr-menu__status"><strong>สถานะการเชื่อมต่อ Facebook</strong><span>ดูแลโดยผู้ดูแลระบบ</span></div>
              : <Link role="menuitem" href="/sources" onClick={() => closeAccount(false)}>{facebook?.canRecover ? "จัดการการเชื่อมต่อ / กู้คืน" : "ดูสถานะการเชื่อมต่อ"}</Link>}
            <div className="rr-menu__identity rr-menu__identity--app"><small>บัญชีแอป</small><strong>{session.user?.displayName ?? "ไม่พบผู้ใช้"}</strong><span>{roleLabels[session.user?.role] ?? session.user?.role ?? "ไม่ทราบสิทธิ์"}</span></div>
            {session.user?.role === "admin" ? <Link role="menuitem" href="/settings" onClick={() => closeAccount(false)}>ตั้งค่าระบบ</Link> : null}
            <button type="button" role="menuitem" className="rr-menu__logout" onClick={() => void logout()}>ออกจากระบบ</button>
          </Menu>
        </div>
      </div>
    </header>
    <aside className="rr-rail" aria-label="เมนูหลัก"><nav className="rr-nav">{routes.map((route) => { const isActive = active.id === route.id; return <Link className={`rr-nav__item${isActive ? " is-active" : ""}`} href={routeHref({ route: route.id })} key={route.id} aria-current={isActive ? "page" : undefined}><AppIcon name={route.icon} size={22} /><span className="rr-nav__label">{route.label}</span><span className="rr-nav__mobile-label">{route.mobileLabel}</span></Link>; })}</nav></aside>
    <main className="rr-main" data-route={active.id}><div className="rr-mobile-title"><span>{active.label}</span></div>{children}</main>
  </div>;
}
