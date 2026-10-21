"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

const fixtureUrl = "http://127.0.0.1:3000/fixture/groups/1001";

export default function Dashboard() {
  const [workspace, setWorkspace] = useState(null);
  const [activeView, setActiveView] = useState("overview");
  const [groupUrl, setGroupUrl] = useState(fixtureUrl);
  const [selectedKey, setSelectedKey] = useState(null);
  const [draft, setDraft] = useState(null);
  const [draftText, setDraftText] = useState("");
  const [review, setReview] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState(null);
  const [session, setSession] = useState(null);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/state", { cache: "no-store" });
    const data = await response.json();
    setWorkspace(data);
    if (data.config.groupUrl) setGroupUrl(data.config.groupUrl);
  }, []);

  useEffect(() => {
    refresh().catch((error) => setNotice({ type: "error", text: error.message }));
  }, [refresh]);

  const request = useCallback(async (label, url, options = {}) => {
    setBusy(label);
    setNotice(null);
    try {
      const response = await fetch(url, {
        ...options,
        headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Request failed");
      await refresh();
      return data;
    } catch (error) {
      setNotice({ type: "error", text: error.message });
      throw error;
    } finally {
      setBusy("");
    }
  }, [refresh]);

  const selected = useMemo(
    () => workspace?.targets.find((target) => target.key === selectedKey) ?? null,
    [workspace, selectedKey],
  );
  const selectedSubmission = workspace?.submissions.find((item) => item.targetKey === selectedKey);

  async function bindGroup() {
    await request("Binding group", "/api/group", { method: "POST", body: JSON.stringify({ url: groupUrl }) });
    setNotice({ type: "success", text: "Group bound to this POC." });
  }

  async function checkSession() {
    const result = await request("Checking browser", "/api/session/check", { method: "POST", body: "{}" });
    setSession(result);
    setNotice({ type: result.state === "connected" ? "success" : "warning", text: result.state === "connected" ? `Connected as ${result.actor}` : "Sign in inside the Browser view." });
  }

  async function scan() {
    const result = await request("Scanning group", "/api/scan", { method: "POST", body: "{}" });
    if (result.targets[0]) setSelectedKey(result.targets[0].key);
    setNotice({ type: "success", text: `Found ${result.count} reply targets.` });
  }

  async function generateDraft() {
    if (!selectedKey) return;
    const result = await request("Generating draft", "/api/drafts", { method: "POST", body: JSON.stringify({ targetKey: selectedKey }) });
    setDraft(result);
    setDraftText(result.text);
  }

  async function openReview() {
    if (!draft) return;
    let current = draft;
    if (draftText !== draft.text) {
      current = await request("Saving draft", `/api/drafts/${draft.id}`, {
        method: "PATCH",
        body: JSON.stringify({ text: draftText, revision: draft.revision }),
      });
      setDraft(current);
    }
    const result = await request("Preparing review", `/api/drafts/${current.id}/review`, {
      method: "POST",
      body: JSON.stringify({ revision: current.revision }),
    });
    setConfirmed(false);
    setReview(result);
  }

  async function submit() {
    const result = await request("Sending once", "/api/submit", {
      method: "POST",
      body: JSON.stringify({ token: review.token, confirmed }),
    });
    setReview(null);
    setNotice({
      type: result.state === "verified" ? "success" : "warning",
      text: result.state === "verified" ? "Reply verified under the selected target." : "Outcome is uncertain. The target remains locked against retries.",
    });
  }

  async function reconcile() {
    const result = await request("Checking evidence", `/api/submissions/${encodeURIComponent(selectedKey)}/reconcile`, { method: "POST", body: "{}" });
    setNotice({ type: result.state === "verified" ? "success" : "warning", text: result.detail });
  }

  if (!workspace) return <div className="boot">Opening review workspace…</div>;

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">R</span><span>Reply Review</span></div>
        <nav aria-label="Workspace navigation">
          <NavButton label="Overview" icon="⌂" active={activeView === "overview"} onClick={() => setActiveView("overview")} />
          <NavButton label="Browser" icon="□" active={activeView === "browser"} onClick={() => setActiveView("browser")} />
          <NavButton label="Activity" icon="◷" active={activeView === "activity"} onClick={() => setActiveView("activity")} />
        </nav>
        <div className="mode-card"><span className="status-dot" /><div><b>{workspace.mode === "fixture" ? "Fixture mode" : "Live mode"}</b><small>{workspace.config.groupName ?? "No group bound"}</small></div></div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div><h1>{activeView === "browser" ? "Remote browser" : activeView === "activity" ? "Activity history" : "Review workspace"}</h1><p>Monitor one authorized group and require exact confirmation before sending.</p></div>
          <button className="mode-button" onClick={checkSession}><span className={`status-dot ${session?.state === "connected" ? "" : "muted"}`} /><span><b>{session?.state === "connected" ? "Browser connected" : workspace.mode === "fixture" ? "Fixture mode" : "Live mode"}</b><small>{workspace.openAIConfigured ? `${workspace.model} ready` : "Mock draft mode"}</small></span><span>›</span></button>
        </header>

        {activeView === "browser" ? <BrowserPanel busy={workspace.browserBusy || Boolean(busy)} /> : null}
        {activeView === "activity" ? <ActivityPanel events={workspace.events} /> : null}
        {activeView === "overview" ? (
          <>
            <WorkflowRail workspace={workspace} draft={draft} />
            {notice ? <div className={`notice ${notice.type}`}>{notice.text}</div> : null}
            <div className="setup-row">
              {workspace.config.groupUrl ? (
                <div className="connected-group">
                  <span className="status-dot" />
                  <span><small>Connected group · saved</small><b>{workspace.config.groupName ?? workspace.config.groupId}</b><a href={workspace.config.groupUrl} target="_blank" rel="noreferrer">{workspace.config.groupUrl}</a></span>
                </div>
              ) : (
                <label><span>Authorized group URL</span><input value={groupUrl} onChange={(event) => setGroupUrl(event.target.value)} /></label>
              )}
              {!workspace.config.groupUrl ? <button className="secondary" onClick={bindGroup} disabled={Boolean(busy)}>Save group</button> : null}
              <button className="primary compact" onClick={scan} disabled={Boolean(busy) || !workspace.config.groupUrl}>{busy === "Scanning group" ? "Scanning…" : "Scan group"}</button>
            </div>
            <div className="content-grid">
              <section className="post-panel">
                <PanelTitle title="Scanned targets" subtitle="Posts and bounded comments from the authorized group" action={<button className="secondary" onClick={scan} disabled={Boolean(busy) || !workspace.config.groupUrl}>↻ Scan again</button>} />
                <div className="target-list">
                  {workspace.targets.length ? workspace.targets.map((target) => <TargetRow key={target.key} target={target} active={target.key === selectedKey} submission={workspace.submissions.find((item) => item.targetKey === target.key)} onClick={() => { setSelectedKey(target.key); setDraft(null); setDraftText(""); }} />) : <EmptyState mode={workspace.mode} onBrowser={() => setActiveView("browser")} />}
                </div>
              </section>
              <section className="draft-panel">
                <PanelTitle title="Reply draft" subtitle={selected ? `Replying to ${selected.author}` : "Select a target to begin"} action={draft ? <span className={`source ${draft.source}`}>{draft.source === "openai" ? "OpenAI" : "Mock"}</span> : null} />
                {selected ? <TargetSummary target={selected} /> : null}
                {selectedSubmission ? <Receipt submission={selectedSubmission} onReconcile={reconcile} /> : draft ? <><label className="editor-label"><span>AI reply draft <small>{draftText.length}/2000</small></span><textarea value={draftText} onChange={(event) => setDraftText(event.target.value)} maxLength={2000} /></label><button className="primary wide" onClick={openReview} disabled={Boolean(busy) || !draftText.trim()}>Review exact reply</button></> : selected ? <button className="primary wide" onClick={generateDraft} disabled={Boolean(busy)}>Generate reply draft</button> : <div className="draft-empty">Choose one post or comment from the left.</div>}
              </section>
            </div>
            <ActivityStrip events={workspace.events} />
          </>
        ) : null}
      </section>

      {review ? <ConfirmModal review={review} confirmed={confirmed} setConfirmed={setConfirmed} busy={busy} onCancel={() => setReview(null)} onSubmit={submit} /> : null}
    </main>
  );
}

function NavButton({ label, icon, active, onClick }) {
  return <button className={active ? "active" : ""} onClick={onClick}><span>{icon}</span>{label}</button>;
}

function WorkflowRail({ workspace, draft }) {
  const steps = [
    ["Connect browser", "Manual login session", true],
    ["Scan group", workspace.targets.length ? `${workspace.targets.length} targets found` : "Bind and scan once", workspace.targets.length > 0],
    ["Review draft", draft ? "Draft ready to edit" : "Choose one target", Boolean(draft)],
    ["Confirm & send", "Exact match required", workspace.submissions.length > 0],
  ];
  return <div className="workflow-rail">{steps.map(([title, detail, done], index) => <div className={`workflow-step ${done ? "done" : ""}`} key={title}><span>{index + 1}</span><div><b>{title}</b><small>{detail}</small></div></div>)}</div>;
}

function PanelTitle({ title, subtitle, action }) {
  return <div className="panel-title"><div><h2>{title}</h2><p>{subtitle}</p></div>{action}</div>;
}

function TargetRow({ target, active, submission, onClick }) {
  return <button className={`target-row ${active ? "selected" : ""}`} onClick={onClick}><span className="selector">{active ? "✓" : ""}</span><span className="avatar">{target.author.slice(0, 1).toUpperCase()}</span><span className="target-copy"><span><b>{target.author}</b><small>{target.kind === "post" ? "Post" : "Comment"}</small></span><p>{target.text}</p><small>{target.context.length} visible context items</small></span>{submission ? <span className={`state ${submission.state}`}>{submission.state}</span> : null}</button>;
}

function TargetSummary({ target }) {
  return <div className="target-summary"><span className="avatar">{target.author.slice(0, 1).toUpperCase()}</span><div><b>{target.author}</b><small>{target.kind} · {target.groupId}</small><p>{target.text}</p></div></div>;
}

function EmptyState({ mode, onBrowser }) {
  const guidance = mode === "live"
    ? "Open the browser, confirm the Facebook session, then scan the authorized group."
    : "Open the browser, complete the fixture login, bind the group, then scan.";
  return <div className="empty"><span>◎</span><h3>No scan results yet</h3><p>{guidance}</p><button className="secondary" onClick={onBrowser}>Open browser</button></div>;
}

function Receipt({ submission, onReconcile }) {
  return <div className={`receipt ${submission.state}`}><span className="receipt-icon">{submission.state === "verified" ? "✓" : "!"}</span><h3>{submission.state === "verified" ? "Reply verified" : "Outcome needs review"}</h3><p>{submission.detail}</p>{submission.evidenceId ? <a href={`/api/evidence/${submission.evidenceId}`} target="_blank">Open screenshot evidence</a> : null}{submission.state !== "verified" ? <button className="secondary" onClick={onReconcile}>Check visible evidence</button> : null}</div>;
}

function ActivityStrip({ events }) {
  return <section className="activity-strip"><PanelTitle title="Activity history" subtitle="Latest durable workflow events" />{events.slice(0, 4).map((event) => <div className="event" key={event.id}><span className="event-dot" /><time>{new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time><b>{event.action.replaceAll("_", " ")}</b><span>{event.detail}</span></div>)}</section>;
}

function ActivityPanel({ events }) {
  return <div className="standalone-panel"><PanelTitle title="Durable event log" subtitle="No credentials, cookies, or authorization headers are recorded" />{events.length ? events.map((event) => <div className="event large" key={event.id}><span className="event-dot" /><time>{new Date(event.at).toLocaleString()}</time><b>{event.action.replaceAll("_", " ")}</b><span>{event.detail}</span></div>) : <p className="muted-copy">No events yet.</p>}</div>;
}

function BrowserPanel({ busy }) {
  const [frameKey, setFrameKey] = useState(0);
  return <div className="browser-panel"><div className="browser-toolbar"><div><h2>Persistent Chromium</h2><p>Credentials stay inside this browser profile.</p></div><button className="secondary" onClick={() => setFrameKey((value) => value + 1)} disabled={busy}>Reconnect view</button></div>{busy ? <div className="browser-locked">Automation owns the browser. The desktop reconnects after the operation finishes.</div> : <iframe key={frameKey} title="Remote Chromium" src="/novnc/vnc.html?path=novnc/websockify&autoconnect=1&resize=scale" />}</div>;
}

function ConfirmModal({ review, confirmed, setConfirmed, busy, onCancel, onSubmit }) {
  return <div className="modal-backdrop" role="presentation"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title"><button className="modal-close" onClick={onCancel} aria-label="Close">×</button><h2 id="confirm-title">Confirm exact reply</h2><p>Review the destination and exact message. This action can only be attempted once for this target.</p><div className="confirm-target"><small>Target</small><b>{review.target.author} · {review.target.kind}</b><p>{review.target.text}</p></div><label className="exact-message"><span>Exact message to send</span><textarea value={review.exactText} readOnly /></label><label className="confirm-check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span><b>I confirm this exact reply and destination</b><small>The server sends the saved review snapshot, not editable client text.</small></span></label><div className="modal-actions"><button className="secondary" onClick={onCancel}>Cancel</button><button className="primary" onClick={onSubmit} disabled={!confirmed || Boolean(busy)}>{busy === "Sending once" ? "Sending…" : "Send once"}</button></div></section></div>;
}

