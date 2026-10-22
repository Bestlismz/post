"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "../lib/api-client.mjs";
import { routeHref, routes } from "../lib/routes.mjs";
import { AppIcon } from "./icons";

function initials(user) {
  const value = user?.displayName ?? user?.name ?? user?.email ?? "RR";
  return value.trim().slice(0, 2).toUpperCase();
}

export function AppShell({ children }) {
  const [session, setSession] = useState({ user: null, connected: null });
  const pathname = usePathname();

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([api.request("/api/me"), api.request("/health")]).then(([identity, health]) => {
      if (cancelled) return;
      setSession({
        user: identity.status === "fulfilled" ? identity.value?.user ?? null : null,
        connected: health.status === "fulfilled" && health.value?.ok === true,
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const active = routes.find((route) => route.path === pathname) ?? routes[0];
  const healthText = session.connected === true ? "เชื่อมต่อแล้ว" : session.connected === false ? "ยังไม่เชื่อมต่อ" : "กำลังตรวจสอบ";

  return (
    <div className="rr-shell">
      <header className="rr-topbar">
        <Link className="rr-brand" href="/inbox">
          <span className="rr-brand__mark" aria-hidden="true">R</span>
          <span className="rr-brand__name">Rental Radar</span>
        </Link>
        <label className="rr-search">
          <AppIcon name="search" />
          <span className="rr-sr-only">ค้นหา</span>
          <input type="search" placeholder="ค้นหาข้อความ ชื่อลูกค้า หรือรหัสห้อง…" />
        </label>
        <div className="rr-topbar__actions">
          <button className="rr-review-filter" type="button">
            <AppIcon name="sliders" size={18} />
            <span>ต้องตรวจ</span>
            <AppIcon name="chevronDown" size={16} />
          </button>
          <span className={`rr-connection rr-connection--${session.connected === true ? "online" : "offline"}`}>
            <i aria-hidden="true" />
            {healthText}
          </span>
          <button className="rr-profile" type="button" aria-label="เปิดเมนูบัญชี">
            <span>{initials(session.user)}</span>
            <b>{session.user?.displayName ?? session.user?.name ?? "ผู้ดูแล"}</b>
            <AppIcon name="chevronDown" size={16} />
          </button>
        </div>
      </header>

      <aside className="rr-rail" aria-label="เมนูหลัก">
        <nav className="rr-nav">
          {routes.map((route) => {
            const isActive = active.id === route.id;
            return (
              <Link
                className={`rr-nav__item${isActive ? " is-active" : ""}`}
                href={routeHref({ route: route.id })}
                key={route.id}
                aria-current={isActive ? "page" : undefined}
              >
                <AppIcon name={route.icon} size={22} />
                <span className="rr-nav__label">{route.label}</span>
                <span className="rr-nav__mobile-label">{route.mobileLabel}</span>
              </Link>
            );
          })}
        </nav>
      </aside>

      <main className="rr-main" data-route={active.id}>
        <div className="rr-mobile-title">
          <span>{active.label}</span>
          <span className={`rr-mobile-title__status rr-mobile-title__status--${session.connected === true ? "online" : "offline"}`}>
            {healthText}
          </span>
        </div>
        {children}
      </main>
    </div>
  );
}
