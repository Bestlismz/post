"use client";

import { useMemo, useState } from "react";
import { SurfaceHead } from "./ui";

export function GroupReview({ workspace, request, busy, setNotice }) {
  const [key, setKey] = useState(null);
  const [draft, setDraft] = useState(null);
  const [text, setText] = useState("");
  const [review, setReview] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const selected = useMemo(() => workspace.targets.find((item) => item.key === key), [workspace, key]);
  const parentPost = useMemo(() => selected ? workspace.targets.find((item) => item.groupId === selected.groupId && item.postId === selected.postId && item.kind === "post") : null, [workspace, selected]);
  const submission = workspace.submissions.find((item) => item.targetKey === key);

  async function generate() {
    const nextDraft = await request("Generating draft", "/api/drafts", { method: "POST", body: JSON.stringify({ targetKey: key }) });
    setDraft(nextDraft);
    setText(nextDraft.text);
  }

  async function openReview() {
    let nextDraft = draft;
    if (text !== nextDraft.text) {
      nextDraft = await request("Saving draft", `/api/drafts/${nextDraft.id}`, { method: "PATCH", body: JSON.stringify({ text, revision: nextDraft.revision }) });
      setDraft(nextDraft);
    }
    const nextReview = await request("Preparing review", `/api/drafts/${nextDraft.id}/review`, { method: "POST", body: JSON.stringify({ revision: nextDraft.revision }) });
    setConfirmed(false);
    setReview(nextReview);
  }

  async function submit() {
    const result = await request("Sending once", "/api/submit", { method: "POST", body: JSON.stringify({ token: review.token, confirmed }) });
    setReview(null);
    setNotice({ type: result.state === "verified" ? "success" : "warning", text: result.detail });
  }

  return <div className="review enter">
    <section className="surface">
      <SurfaceHead title="Group reply review" subtitle="Group replies never send automatically" />
      <div className="targets">{workspace.targets.map((item) => <button className={item.key === key ? "selected" : ""} key={item.key} onClick={() => { setKey(item.key); setDraft(null); setText(""); }}>
        <i>{item.author[0]}</i><span><b>{item.author}</b><p>{item.text}</p><small>{item.kind} · Group {item.groupId}</small></span>
        {workspace.submissions.some((entry) => entry.targetKey === item.key) ? <em>LOCKED</em> : null}
      </button>)}</div>
    </section>
    <section className="surface editor">
      <SurfaceHead title="Post conversation" subtitle={selected ? `Group ${selected.groupId} · Replying as Rental Radar` : "Choose a target"} />
      {selected ? <PostConversation target={selected} post={parentPost || selected} submission={submission} draft={draft} text={text} setText={setText} generate={generate} openReview={openReview} busy={busy} /> : <div className="empty">Choose one item from the left.</div>}
    </section>
    {review ? <div className="backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="reply-confirm-title">
      <button className="close" onClick={() => setReview(null)} aria-label="Close review">×</button><small>IMMUTABLE REVIEW</small><h2 id="reply-confirm-title">Confirm exact reply</h2><p>This target can be attempted once.</p>
      <div className="summary"><b>{review.target.author} · {review.target.kind}</b><p>{review.target.text}</p></div>
      <label>Exact message<textarea value={review.exactText} readOnly /></label><label className="check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> I confirm this exact reply and destination</label>
      <footer><button onClick={() => setReview(null)}>Cancel</button><button className="primary" onClick={submit} disabled={!confirmed || !!busy}>Send once</button></footer>
    </section></div> : null}
  </div>;
}

function PostConversation({ target, post, submission, draft, text, setText, generate, openReview, busy }) {
  return <div className="post-conversation">
    <article className="post-preview">
      <header><span className="facebook-avatar">{post.author[0]}</span><span><b>{post.author}</b><small>Facebook Group {target.groupId} · Public</small></span></header>
      <p>{post.postText || post.text}</p>
      <div className="post-actions"><span>Like</span><span>Comment</span><span>Share</span></div>
    </article>
    <div className="comment-thread">
      {target.kind === "comment" ? <div className="comment-row"><span className="facebook-avatar muted">{target.author[0]}</span><div><div className="comment-bubble"><b>{target.author}</b><p>{target.text}</p></div><small>Like · Reply · selected comment</small></div></div> : null}
      {submission ? <VerifiedComment submission={submission} /> : <div className="comment-composer"><span className="brand-avatar">R</span>{draft ? <div className="composer-body"><label htmlFor="group-reply-text">Replying to {target.author} <small>{text.length}/2000</small></label><textarea id="group-reply-text" value={text} maxLength={2000} onChange={(event) => setText(event.target.value)} /><button className="primary" onClick={openReview} disabled={!!busy || !text}>Review exact reply</button></div> : <button className="composer-placeholder" aria-label="Generate reply draft" onClick={generate} disabled={!!busy}>Write a reply to {target.author}… <b>Generate draft</b></button>}</div>}
    </div>
  </div>;
}

function VerifiedComment({ submission }) {
  const verified = submission.state === "verified";
  const timestamp = submission.finishedAt || submission.createdAt;
  return <div className={`comment-row own ${verified ? "verified" : "uncertain"}`}>
    <span className="brand-avatar">R</span><div className="verified-comment"><div className="comment-bubble"><b>Rental Radar <span className="verified-mark"><VerifiedIcon verified={verified} /></span></b><p>{submission.exactText}</p></div>
      <div className="comment-meta"><span><b>{verified ? "Reply verified" : "Outcome locked"}</b> · {timestamp ? new Date(timestamp).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "Time unavailable"}</span>{submission.evidenceId ? <a href={`/api/evidence/${submission.evidenceId}`} target="_blank" rel="noreferrer">Evidence <ExternalIcon /></a> : null}</div>
    </div>
  </div>;
}

function VerifiedIcon({ verified }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{verified ? <><path d="m7 12 3.2 3.2L17.5 8" /><circle cx="12" cy="12" r="9" /></> : <><circle cx="12" cy="12" r="9" /><path d="M12 7v6M12 17h.01" /></>}</svg>;
}

function ExternalIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 5h5v5M13 11l6-6M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" /></svg>;
}
