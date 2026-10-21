"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { buildConversation, buildConversationOptions } from "../../src/conversation.mjs";

export function GroupReview({ workspace, request, busy, setNotice }) {
  const [key, setKey] = useState(null);
  const [reviewing, setReviewing] = useState(false);
  const options = useMemo(() => buildConversationOptions(workspace), [workspace]);
  const conversation = useMemo(() => buildConversation(workspace, key), [workspace, key]);
  const index = options.findIndex((option) => option.id === conversation?.id);
  const groupIds = [...new Set(options.map((option) => option.groupId))];
  const locked = !!busy || reviewing;
  const identity = "Rental Radar";
  function selectTarget(nextKey) {
    if (!locked) setKey(nextKey);
  }
  const composer = conversation ? <ReplyWorkflow key={conversation.selectedTarget.key} target={conversation.selectedTarget} identity={identity} request={request} busy={busy} setNotice={setNotice} onReviewing={setReviewing} /> : null;

  return <div className="group-review enter">
    <div className="conversation-toolbar">
      <div className="conversation-choice"><label htmlFor="conversation-select">Choose conversation</label><select id="conversation-select" value={conversation?.id || ""} disabled={locked || !options.length} onChange={(event) => selectTarget(options.find((option) => option.id === event.target.value).targetKey)}>
        <option value="" disabled>{options.length ? "Select a scanned post" : "Scan a group to collect posts"}</option>
        {groupIds.map((groupId) => <optgroup key={groupId} label={options.find((option) => option.groupId === groupId).groupLabel}>{options.filter((option) => option.groupId === groupId).map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</optgroup>)}
      </select></div>
      <div className="conversation-navigation"><button aria-label="Previous conversation" disabled={locked || index <= 0} onClick={() => selectTarget(options[index - 1].targetKey)}>←</button><button aria-label="Next conversation" disabled={locked || index >= options.length - 1} onClick={() => selectTarget(options[index + 1].targetKey)}>→</button></div>
    </div>
    <p className="conversation-scope">{conversation ? `Reply targets: ${conversation.post.target ? "post · " : ""}${conversation.comments.length} scanned comments` : "Choose a scanned conversation to read its post and reply targets."}</p>
    {conversation ? <PostConversation conversation={conversation} identity={identity} composer={composer} onSelectTarget={selectTarget} disabled={locked} /> : <div className="conversation-empty">{options.length ? "Select a conversation above to begin." : "No conversations have been scanned yet."}</div>}
  </div>;
}

function PostConversation({ conversation, identity, composer, onSelectTarget, disabled }) {
  const { post, comments, selectedTarget } = conversation;
  const postSelected = selectedTarget.key === post.target?.key;
  return <article className="fb-thread" aria-label={`Scanned conversation in ${conversation.group.label}`}>
    <header className="fb-post-header"><Avatar name={post.author || "Original post"} large /><div><b>{post.author || "Original post"}</b><span>{conversation.group.label}</span><small>{post.kind === "captured" ? "Scanned conversation" : "Original post context"}</small></div></header>
    <p className="fb-post-text">{post.text || "Original post text was not captured."}</p>
    <div className="fb-post-actions">{post.target ? <button aria-label={`Reply to post by ${post.author}`} aria-pressed={postSelected} disabled={disabled} onClick={() => onSelectTarget(post.target.key)}>Reply to post{postSelected ? <span className="replying-chip">Replying here</span> : null}</button> : <span>Post reply target not captured</span>}<a href={conversation.sourceUrl} target="_blank" rel="noreferrer">Open original on Facebook ↗</a></div>
    <div className="fb-thread-body">
      {conversation.postSubmission ? <SubmissionResult submission={conversation.postSubmission} identity={identity} /> : postSelected ? composer : null}
      <h2>Scanned comments <span>({comments.length})</span></h2>
      {comments.length ? <ol className="fb-comments">{comments.map(({ target, submission }) => <li key={target.key}>
        <div className={`fb-comment ${target.key === selectedTarget.key ? "is-selected" : ""}`}><Avatar name={target.author} /><div className="fb-comment-content"><div className="fb-comment-bubble"><b>{target.author}</b><p>{target.text}</p></div><div className="fb-comment-actions"><button aria-label={`Reply to comment by ${target.author}: ${target.text.slice(0, 60)}`} aria-pressed={target.key === selectedTarget.key} disabled={disabled} onClick={() => onSelectTarget(target.key)}>Reply</button><a href={target.url} target="_blank" rel="noreferrer">View on Facebook ↗</a>{target.key === selectedTarget.key ? <span className="replying-chip">Replying here</span> : null}</div></div></div>
        {submission ? <div className="fb-reply-region"><SubmissionResult submission={submission} identity={identity} /></div> : target.key === selectedTarget.key ? <div className="fb-reply-region">{composer}</div> : null}
      </li>)}</ol> : <p className="fb-no-comments">No comments were captured for this post.</p>}
    </div>
  </article>;
}

function ReplyWorkflow({ target, identity, request, busy, setNotice, onReviewing }) {
  const [session, setSession] = useState({ phase: "empty", targetKey: target.key });
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const active = useRef(true);
  const operation = useRef(false);
  const reviewButton = useRef(null);
  const inputId = useId();
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; onReviewing(false); };
  }, [onReviewing]);
  async function run(label, action) {
    if (operation.current || !active.current) return;
    operation.current = true;
    setPending(label);
    setError("");
    try { await action(); } catch (failure) { if (active.current) setError(failure.message || "The request failed."); }
    finally { operation.current = false; if (active.current) setPending(""); }
  }
  function generate() {
    void run("Generating draft…", async () => {
      const draft = await request("Generating draft", "/api/drafts", { method: "POST", body: JSON.stringify({ targetKey: target.key }) });
      if (active.current && draft.targetKey === target.key) setSession({ phase: "draft", targetKey: target.key, draft, text: draft.text });
    });
  }
  function openReview() {
    if (session.phase !== "draft") return;
    void run("Preparing review…", async () => {
      let draft = session.draft;
      if (session.text !== draft.text) {
        draft = await request("Saving draft", `/api/drafts/${draft.id}`, { method: "PATCH", body: JSON.stringify({ text: session.text, revision: draft.revision }) });
        if (!active.current || draft.targetKey !== target.key) return;
        setSession({ phase: "draft", targetKey: target.key, draft, text: draft.text });
      }
      if (!active.current) return;
      const snapshot = await request("Preparing review", `/api/drafts/${draft.id}/review`, { method: "POST", body: JSON.stringify({ revision: draft.revision }) });
      if (!active.current || snapshot.targetKey !== target.key) return;
      setSession({ phase: "review", targetKey: target.key, draft, text: snapshot.exactText, snapshot, confirmed: false });
      onReviewing(true);
    });
  }
  function closeReview() {
    if (operation.current) return;
    setSession({ phase: "draft", targetKey: target.key, draft: session.draft, text: session.text });
    onReviewing(false);
    requestAnimationFrame(() => reviewButton.current?.focus());
  }
  function submit() {
    if (session.phase !== "review" || !session.confirmed) return;
    void run("Sending once…", async () => {
      const result = await request("Sending once", "/api/submit", { method: "POST", body: JSON.stringify({ token: session.snapshot.token, confirmed: session.confirmed }) });
      if (!active.current) return;
      onReviewing(false);
      setSession({ phase: "empty", targetKey: target.key });
      setNotice({ type: result.state === "verified" ? "success" : "warning", text: result.detail });
    });
  }
  const disabled = !!busy || !!pending;
  return <>
    <div className="fb-composer"><Avatar name={identity} /><div className="fb-composer-content"><span className="fb-reply-identity">{identity}</span>{session.phase === "empty" ? <button className="fb-composer-placeholder" aria-label="Generate reply draft" disabled={disabled} onClick={generate}><span>Generate a draft reply to {target.author}…</span><b>Generate draft</b></button> : <><label htmlFor={inputId}>Replying to {target.author}</label><textarea id={inputId} aria-describedby={`${inputId}-help`} value={session.text} maxLength={2000} disabled={disabled || session.phase === "review"} onChange={(event) => setSession({ phase: "draft", targetKey: target.key, draft: session.draft, text: event.target.value })} /><div className="fb-composer-footer"><small id={`${inputId}-help`}>{session.text.length}/2000 · Enter adds a line break</small><button ref={reviewButton} className="primary" disabled={disabled || !session.text.trim()} onClick={openReview}>Review exact reply</button></div></>}<p className="fb-workflow-status" role="status" aria-live="polite">{error || pending}</p></div></div>
    {session.phase === "review" ? <ExactReplyReview review={session.snapshot} confirmed={session.confirmed} busy={disabled} onConfirm={(confirmed) => setSession({ ...session, confirmed })} onCancel={closeReview} onSubmit={submit} /> : null}
  </>;
}

function ExactReplyReview({ review, confirmed, busy, onConfirm, onCancel, onSubmit }) {
  const dialog = useRef(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  useEffect(() => {
    const root = document.querySelector(".app-shell");
    const wasInert = root?.inert;
    if (root) root.inert = true;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.current.focus();
    function handleKey(event) {
      if (event.key === "Escape" && !busyRef.current) { event.preventDefault(); cancelRef.current(); }
      if (event.key !== "Tab") return;
      const controls = [...dialog.current.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href]')];
      const first = controls[0], last = controls.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", handleKey);
    return () => { if (root) root.inert = wasInert; document.body.style.overflow = previousOverflow; document.removeEventListener("keydown", handleKey); };
  }, []);
  return createPortal(<div className="backdrop group-review-dialog"><section ref={dialog} className="modal" role="dialog" aria-modal="true" aria-labelledby="reply-confirm-title" tabIndex={-1}>
    <button className="close" disabled={busy} onClick={onCancel} aria-label="Close review">×</button><small>IMMUTABLE REVIEW</small><h2 id="reply-confirm-title">Confirm exact reply</h2><p>This target can be attempted once.</p>
    <div className="summary"><b>{review.target.groupName}</b><p>Post {review.target.postId} · {review.target.kind}{review.target.commentId ? ` · Comment ${review.target.commentId}` : ""}</p><b>{review.target.author}</b><p>{review.target.text}</p><a href={review.target.url} target="_blank" rel="noreferrer">View exact destination on Facebook ↗</a></div>
    <label>Exact message<textarea value={review.exactText} readOnly /></label><label className="check"><input type="checkbox" disabled={busy} checked={confirmed} onChange={(event) => onConfirm(event.target.checked)} /> I confirm this exact reply and destination</label>
    <footer><button disabled={busy} onClick={onCancel}>Cancel</button><button className="primary" disabled={!confirmed || busy} onClick={onSubmit}>Send once</button></footer>
  </section></div>, document.body);
}

function SubmissionResult({ submission, identity }) {
  const verified = submission.state === "verified";
  const timestamp = verified ? submission.finishedAt || submission.createdAt : submission.createdAt;
  const date = timestamp && !Number.isNaN(new Date(timestamp).valueOf()) ? new Date(timestamp).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : null;
  const evidence = submission.evidenceId ? <a href={`/api/evidence/${encodeURIComponent(submission.evidenceId)}`} target="_blank" rel="noreferrer">View app evidence ↗</a> : null;
  return <div className={`fb-submission ${verified ? "is-verified" : "is-unconfirmed"}`} role="status">
    {verified ? <div className="fb-comment"><Avatar name={identity} /><div className="fb-comment-content"><div className="fb-comment-bubble"><b>{identity}</b><p>{submission.exactText}</p></div><div className="fb-submission-meta"><b>Verified by this app</b>{date ? <span>Verification completed {date}</span> : null}{evidence}</div></div></div> : <><b>{submission.state === "attempted" ? "Attempt in progress" : "Attempt recorded · publication unconfirmed"}</b><p className="fb-attempt-text">{submission.exactText}</p>{submission.detail ? <p>{submission.detail}</p> : null}{date ? <small>Attempt recorded {date}</small> : null}{evidence}</>}
    <p className="fb-target-lock">Sending is locked for this target.</p>
  </div>;
}

function Avatar({ name, large = false }) {
  return <span className={`fb-avatar${large ? " large" : ""}`} aria-hidden="true">{Array.from(name || "?")[0]}</span>;
}
