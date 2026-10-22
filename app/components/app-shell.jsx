"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api-client.mjs";
import { routeHref, routes } from "../lib/routes.mjs";
import { AppIcon } from "./icons";

const roleLabels = { admin: "ผู้ดูแลระบบ", operator: "เจ้าหน้าที่", inventory_manager: "ผู้จัดการข้อมูลห้อง", viewer: "ผู้ดูข้อมูล" };
const reviewPresets = [
  { value: "", label: "ทั้งหมด", countKey: "all" },
  { value: "needs_review", label: "ต้องตรวจ", countKey: "review" },
  { value: "pending_or_updated", label: "ใหม่หรืออัปเดต", countKey: "new" },
];
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
  const [session, setSession] = useState({ user: null, connected: null, csrfToken: "", facebook: null });
  const [counts, setCounts] = useState({ all: 0, review: 0, new: 0 });
  const [reviewOpen, setReviewOpen] = useState(false), [accountOpen, setAccountOpen] = useState(false), [search, setSearch] = useState("");
  const pathname = usePathname(), searchParams = useSearchParams(), router = useRouter();
  const reviewButton = useRef(null), accountButton = useRef(null);

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([api.request("/api/me"), api.request("/health"), api.request("/api/facebook/session-summary")]).then(([identity, health, facebook]) => {
      if (cancelled) return;
      setSession({
        user: identity.status === "fulfilled" ? identity.value?.user ?? null : null,
        connected: health.status === "fulfilled" && health.value?.ok === true,
        csrfToken: "",
        facebook: facebook.status === "fulfilled" ? facebook.value : null,
      });
    });
    Promise.allSettled([
      api.request("/api/inbox?limit=1"),
      api.request("/api/inbox?limit=1&status=needs_review"),
      api.request("/api/inbox?limit=1&status=pending_or_updated"),
    ]).then((values) => { if (!cancelled) setCounts({ all: values[0].value?.resultCount ?? 0, review: values[1].value?.resultCount ?? 0, new: values[2].value?.resultCount ?? 0 }); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => { if (pathname === "/inbox") setSearch(searchParams.get("q") ?? ""); }, [pathname, searchParams]);

  const active = routes.find((route) => route.path === pathname) ?? routes[0];
  const activeStatus = pathname === "/inbox" ? searchParams.get("status") ?? "" : "";
  const activePreset = reviewPresets.find((preset) => preset.value === activeStatus) ?? reviewPresets[0];
  const closeReview = useCallback((restore) => { setReviewOpen(false); if (restore) requestAnimationFrame(() => reviewButton.current?.focus()); }, []);
  const closeAccount = useCallback((restore) => { setAccountOpen(false); if (restore) requestAnimationFrame(() => accountButton.current?.focus()); }, []);
  const choosePreset = (preset) => { router.push(preset.value ? `/inbox?status=${preset.value}` : "/inbox"); closeReview(false); };
  const submitSearch = (event) => { event.preventDefault(); const value = search.trim(); router.push(value ? `/inbox?q=${encodeURIComponent(value)}` : "/inbox"); };
  const logout = async () => {
    const csrfToken = session.csrfToken || (await api.request("/api/auth/csrf", { method: "POST" }))?.csrfToken;
    if (!csrfToken) return;
    await api.request("/api/auth/logout", { method: "POST", headers: { "X-CSRF-Token": csrfToken }, body: "{}" });
    setSession((value) => ({ ...value, user: null, csrfToken: "" })); closeAccount(false); router.replace("/");
  };
  const facebook = session.facebook, fbConnected = facebook?.state === "connected", fbName = fbConnected ? facebook?.identity?.displayName : null, avatar = safeAvatar(facebook?.identity?.avatarUrl);
  const healthText = session.connected === true ? "เชื่อมต่อแล้ว" : session.connected === false ? "ยังไม่เชื่อมต่อ" : "กำลังตรวจสอบ";

  return <div className="rr-shell">
    <header className="rr-topbar">
      <Link className="rr-brand" href="/inbox"><span className="rr-brand__mark" aria-hidden="true">R</span><span className="rr-brand__name">Rental Radar</span></Link>
      <form className="rr-search" role="search" onSubmit={submitSearch}><AppIcon name="search" /><input aria-label="ค้นหาทั่วทั้ง Inbox" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="ค้นหาข้อความ ชื่อลูกค้า หรือรหัสห้อง…" /></form>
      <div className="rr-topbar__actions">
        <div className="rr-menu-anchor">
          <button className="rr-review-filter" type="button" ref={reviewButton} aria-label={`คิวที่ต้องตรวจ ${counts.review}`} aria-haspopup="menu" aria-expanded={reviewOpen} onClick={() => { setAccountOpen(false); setReviewOpen((value) => !value); }}><AppIcon name="sliders" size={18} /><span>{activePreset.label}</span><strong>{counts[activePreset.countKey]}</strong><AppIcon name="chevronDown" size={16} /></button>
          <Menu buttonRef={reviewButton} open={reviewOpen} onClose={closeReview} label="ตัวกรองคิวด่วน" activeIndex={Math.max(0, reviewPresets.indexOf(activePreset))}>{reviewPresets.map((preset) => <button type="button" role="menuitemradio" aria-checked={preset.value === activePreset.value} key={preset.value || "all"} onClick={() => choosePreset(preset)}><span>{preset.label}</span><strong>{counts[preset.countKey]}</strong></button>)}</Menu>
        </div>
        <span className={`rr-connection rr-connection--${session.connected === true ? "online" : "offline"}`}><i aria-hidden="true" />{healthText}</span>
        <div className="rr-menu-anchor">
          <button className="rr-profile" type="button" ref={accountButton} aria-label="เปิดเมนูบัญชี" aria-haspopup="menu" aria-expanded={accountOpen} onClick={() => { setReviewOpen(false); setAccountOpen((value) => !value); }}>
            {avatar ? <img src={avatar} alt="" referrerPolicy="no-referrer" /> : <span>{initials(fbName || session.user?.displayName)}</span>}<b>{fbName || "ยังไม่เชื่อมต่อ Facebook"}</b><AppIcon name="chevronDown" size={16} />
          </button>
          <Menu buttonRef={accountButton} open={accountOpen} onClose={closeAccount} label="เมนูบัญชี">
            <div className="rr-menu__identity"><small>Facebook identity</small><strong>{fbName || "ยังไม่เชื่อมต่อ Facebook"}</strong><span>{facebook?.state === "reauth_required" ? "ต้องเข้าสู่ระบบ Facebook ใหม่" : fbConnected ? `Page ${facebook.connections?.pages ?? 0} · Group ${facebook.connections?.groups ?? 0}` : "ไม่มีเซสชันที่พร้อมใช้งาน"}</span></div>
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
    <main className="rr-main" data-route={active.id}><div className="rr-mobile-title"><span>{active.label}</span><span className={`rr-mobile-title__status rr-mobile-title__status--${session.connected === true ? "online" : "offline"}`}>{healthText}</span></div>{children}</main>
  </div>;
}
