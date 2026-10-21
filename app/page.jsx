"use client";
import { useCallback, useEffect, useState } from "react";
import {
  CommandCenter,
  GroupsView,
  LeadsView,
  OperationStatus,
  SettingsView,
} from "./components/command-center";
import { GroupReview } from "./components/group-review";
import { MessengerInbox } from "./components/messenger-inbox";
import { ReplySettings } from "./components/reply-settings";
import { NavItem, StatusDot, SurfaceHead } from "./components/ui";
const nav = [
  ["overview", "Overview", "overview"],
  ["leads", "Lead inbox", "leads"],
  ["groups", "Groups", "groups"],
  ["review", "Reply review", "review"],
  ["messenger", "Messenger", "messenger"],
  ["browser", "Facebook login", "browser"],
  ["activity", "Activity", "activity"],
  ["settings", "Settings", "settings"],
];
const viewIds = new Set(nav.map(([id]) => id));
export default function Dashboard() {
  const [workspace, setWorkspace] = useState(null),
    [view, setView] = useState("review"),
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
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("view");
    if (viewIds.has(requested)) setView(requested);
  }, []);
  const navigate = useCallback((nextView) => {
    setView(nextView);
    const url = new URL(window.location.href);
    if (nextView === "review") url.searchParams.delete("view");
    else url.searchParams.set("view", nextView);
    window.history.replaceState(null, "", url);
  }, []);
  useEffect(() => {
    if (!busy && workspace?.browserOperation?.status !== "running") return;
    const timer = window.setInterval(() => refresh().catch(() => undefined), 900);
    return () => window.clearInterval(timer);
  }, [busy, refresh, workspace?.browserOperation?.status]);
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
              onClick={() => navigate(id)}
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
            onNavigate={navigate}
            onScanAll={actions.scanAll}
            busy={busy}
          />
        ) : null}
        {view === "leads" ? (
          <LeadsView workspace={workspace} onReview={() => navigate("review")} />
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
          <MessengerInbox
            workspace={workspace}
            request={request}
            busy={busy}
            setNotice={setNotice}
            onSettings={() => navigate("settings")}
          />
        ) : null}
        {view === "settings" ? (
          <div className="stack">
            <SettingsView
              workspace={workspace}
              request={request}
              busy={busy}
              setNotice={setNotice}
            />
            <ReplySettings workspace={workspace} request={request} busy={busy} setNotice={setNotice} />
          </div>
        ) : null}
        {view === "browser" ? (
          <Browser workspace={workspace} request={request} busy={busy} />
        ) : null}
        {view === "activity" ? <Activity events={workspace.events} /> : null}
      </section>
    </main>
  );
}
function Browser({ workspace, request, busy }) {
  const [k, setK] = useState(0);
  const [session, setSession] = useState(null);
  const locked = workspace.browserBusy;
  const checking = busy === "Checking Facebook session";
  async function checkSession() {
    try {
      const result = await request("Checking Facebook session", "/api/session/check", {
        method: "POST",
        body: "{}",
      });
      setSession(result);
      setK((value) => value + 1);
    } catch {
      setSession({ state: "not_connected", actor: null });
    }
  }
  const connected = session?.state === "connected";
  return (
    <div className="browser-layout enter">
      <section className="surface browser-stage">
        <SurfaceHead
          title="Sign in to Facebook"
          subtitle="Use Facebook directly in this secure browser panel"
          action={<button onClick={() => setK((value) => value + 1)} disabled={locked}>Reload browser</button>}
        />
        {locked ? (
          <div className="browser-lock"><span className="browser-orbit"><i/><i/><i/></span><h2>Automation has control</h2><p>Input is temporarily locked to prevent clicks from colliding with the worker.</p></div>
        ) : (
          <iframe
            key={k}
            title="Remote Chromium"
            src="/novnc/vnc.html?path=novnc/websockify&autoconnect=1&resize=scale"
          />
        )}
      </section>
      <aside className="surface browser-status">
        <SurfaceHead title="Facebook connection" subtitle="One login works across all saved groups"/>
        <div className={`facebook-session ${connected ? "connected" : session ? "disconnected" : "unchecked"}`}>
          <div className="facebook-session-title">
            <span className="facebook-mark" aria-hidden="true">f</span>
            <span>
              <b>{connected ? "Connected" : session ? "Sign in required" : "Connection not checked"}</b>
              <small>{connected ? session.actor : session ? "Log in below, then check again" : "Check the saved browser session"}</small>
            </span>
          </div>
          <button className="primary" onClick={checkSession} disabled={locked || checking}>
            {checking ? "Checking…" : connected ? "Check again" : "Check Facebook session"}
          </button>
        </div>
        <ol className="login-steps">
          <li><span>1</span><div><b>Sign in below</b><p>Enter your account details only on the Facebook page.</p></div></li>
          <li><span>2</span><div><b>Complete Facebook security</b><p>Finish any two-factor or device confirmation Facebook requests.</p></div></li>
          <li><span>3</span><div><b>Verify the connection</b><p>Click “Check Facebook session” before scanning groups.</p></div></li>
        </ol>
        <div className="credential-note"><span aria-hidden="true">&#x1F512;</span><p><b>Your password stays with Facebook</b>The app stores the browser session, never your Facebook password.</p></div>
        <SurfaceHead title="Automation status" subtitle="What the worker is doing now"/>
        <OperationStatus operation={workspace.browserOperation}/>
        <div className="browser-note"><b>Safe control handoff</b><p>You can browse and sign in while idle. During a scan or reply, control moves to automation and returns automatically.</p></div>
      </aside>
    </div>
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
