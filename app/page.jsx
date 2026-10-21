"use client";
import { useCallback, useEffect, useState } from "react";
import {
  CommandCenter,
  GroupsView,
  LeadsView,
  MessengerPlaceholder,
  SettingsView,
} from "./components/command-center";
import { GroupReview } from "./components/group-review";
import { NavItem, StatusDot, SurfaceHead } from "./components/ui";
const nav = [
  ["overview", "Overview", "⌂"],
  ["leads", "Lead inbox", "◎"],
  ["groups", "Groups", "◫"],
  ["review", "Reply review", "✎"],
  ["messenger", "Messenger", "◌"],
  ["browser", "Browser", "□"],
  ["activity", "Activity", "◷"],
  ["settings", "Settings", "⚙"],
];
export default function Dashboard() {
  const [workspace, setWorkspace] = useState(null),
    [view, setView] = useState("overview"),
    [busy, setBusy] = useState(""),
    [notice, setNotice] = useState(null);
  const refresh = useCallback(async () => {
    const r = await fetch("/api/state", { cache: "no-store" }),
      d = await r.json();
    if (!r.ok) throw new Error(d.error || "Could not load workspace");
    setWorkspace(d);
    return d;
  }, []);
  useEffect(() => {
    refresh().catch((e) => setNotice({ type: "error", text: e.message }));
  }, [refresh]);
  const request = useCallback(
    async (label, url, options = {}) => {
      setBusy(label);
      setNotice(null);
      try {
        const r = await fetch(url, {
            ...options,
            headers: {
              "Content-Type": "application/json",
              ...(options.headers || {}),
            },
          }),
          raw = await r.text(),
          d = raw ? JSON.parse(raw) : {};
        if (!r.ok) throw new Error(d.error || "Request failed");
        await refresh();
        return d;
      } catch (e) {
        setNotice({ type: "error", text: e.message });
        throw e;
      } finally {
        setBusy("");
      }
    },
    [refresh],
  );
  if (!workspace)
    return (
      <main className="boot">
        <img
          className="boot-logo"
          src="/rental-radar-logo.png"
          alt="Rental Radar"
        />
        <p>{notice?.text || "Opening command center…"}</p>
      </main>
    );
  const actions = {
    add: async (url) => {
      await request("Adding group", "/api/groups", {
        method: "POST",
        body: JSON.stringify({ url }),
      });
      setNotice({ type: "success", text: "Group saved." });
    },
    scan: (id) =>
      request("Scanning group", `/api/groups/${id}/scan`, {
        method: "POST",
        body: "{}",
      }),
    toggle: (id, enabled) =>
      request("Updating group", `/api/groups/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled }),
      }),
    scanAll: async () => {
      const d = await request("Scanning all groups", "/api/groups/scan-all", {
        method: "POST",
        body: "{}",
      });
      setNotice({
        type: d.failed ? "warning" : "success",
        text: `Scanned ${d.completed} Groups. Found ${d.relevant} relevant leads.`,
      });
    },
  };
  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <img
            className="brand-logo"
            src="/rental-radar-logo.png"
            alt=""
          />
          <span>
            <b>Rental Radar</b>
            <small>Lead command center</small>
          </span>
        </div>
        <nav>
          {nav.map(([id, label, icon]) => (
            <NavItem
              key={id}
              label={label}
              icon={icon}
              active={view === id}
              onClick={() => setView(id)}
            />
          ))}
        </nav>
        <div className="mode-card">
          <StatusDot state={workspace.messenger.enabled ? "live" : "muted"} />
          <span>
            <b>
              {workspace.messenger.enabled
                ? "Auto-reply active"
                : "Auto-reply paused"}
            </b>
            <small>{workspace.groups.length} Groups saved</small>
          </span>
        </div>
      </aside>
      <section className="workspace">
        <header className="topbar">
          <div>
            <small>RENTAL INTELLIGENCE</small>
            <h1>{nav.find((x) => x[0] === view)?.[1]}</h1>
            <p>Find demand, qualify leads, and keep every reply controlled.</p>
          </div>
          <div className="system-pill">
            <StatusDot
              state={workspace.messenger.configured ? "live" : "warning"}
            />
            <span>
              <b>
                {workspace.messenger.configured
                  ? "Systems ready"
                  : "Messenger needs setup"}
              </b>
              <small>
                {workspace.openAIConfigured
                  ? `${workspace.model} connected`
                  : "Rules fallback active"}
              </small>
            </span>
          </div>
        </header>
        {notice ? (
          <div className={`notice ${notice.type}`}>
            {notice.text}
            <button onClick={() => setNotice(null)}>×</button>
          </div>
        ) : null}
        {view === "overview" ? (
          <CommandCenter
            workspace={workspace}
            onNavigate={setView}
            onScanAll={actions.scanAll}
            busy={busy}
          />
        ) : null}
        {view === "leads" ? (
          <LeadsView workspace={workspace} onReview={() => setView("review")} />
        ) : null}
        {view === "groups" ? (
          <GroupsView workspace={workspace} actions={actions} busy={busy} />
        ) : null}
        {view === "review" ? (
          <GroupReview
            workspace={workspace}
            request={request}
            busy={busy}
            setNotice={setNotice}
          />
        ) : null}
        {view === "messenger" ? (
          <MessengerPlaceholder
            workspace={workspace}
            onSettings={() => setView("settings")}
          />
        ) : null}
        {view === "settings" ? (
          <SettingsView
            workspace={workspace}
            request={request}
            busy={busy}
            setNotice={setNotice}
          />
        ) : null}
        {view === "browser" ? (
          <Browser busy={workspace.browserBusy || !!busy} />
        ) : null}
        {view === "activity" ? <Activity events={workspace.events} /> : null}
      </section>
    </main>
  );
}
function Browser({ busy }) {
  const [k, setK] = useState(0);
  return (
    <section className="surface">
      <SurfaceHead
        title="Persistent Chromium"
        subtitle="Credentials stay inside this browser profile"
        action={<button onClick={() => setK(k + 1)}>Reconnect</button>}
      />
      {busy ? (
        <div className="empty">Automation owns the browser.</div>
      ) : (
        <iframe
          key={k}
          title="Remote Chromium"
          src="/novnc/vnc.html?path=novnc/websockify&autoconnect=1&resize=scale"
        />
      )}
    </section>
  );
}
function Activity({ events }) {
  return (
    <section className="surface">
      <SurfaceHead
        title="Durable activity"
        subtitle="No credentials or tokens are recorded"
      />
      <div className="activity">
        {events.map((e) => (
          <div key={e.id}>
            <StatusDot />
            <time>{new Date(e.at).toLocaleString()}</time>
            <b>{e.action.replaceAll("_", " ")}</b>
            <span>{e.detail}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
