"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, ExternalLink, LoaderCircle, MessageCircleMore, MoreHorizontal, Pencil, RefreshCw, Share2, ThumbsUp, UsersRound } from "lucide-react";
import { pickGroupPost } from "./timeline.mjs";

function formatDate(value) {
  const date = new Date(value); if (!Number.isFinite(date.valueOf())) return "";
  return new Intl.DateTimeFormat("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" }).format(date);
}

export function ConversationPane({ detail, loading, error, onRetry, runCommand, onRefresh, commandsReady, composer = null }) {
  if (loading && !detail) return <div className="conversation-skeleton" aria-label="กำลังโหลดรายละเอียด"><i /><i /><i /><i /></div>;
  if (error) return <div className="inbox-detail-error" role="alert"><div><RefreshCw size={24} /><strong>โหลดรายละเอียดส่วนนี้ไม่ได้</strong><p>คิวด้านซ้ายยังใช้งานได้ตามปกติ กรุณาลองเฉพาะรายละเอียดอีกครั้ง</p></div><button type="button" onClick={onRetry}><RefreshCw size={17} />ลองโหลดรายละเอียดอีกครั้ง</button></div>;
  if (!detail) return <div className="inbox-no-selection"><MessageCircleMore size={30} /><strong>เลือกข้อความเพื่อเริ่มทำงาน</strong><p>ดูบริบท วิเคราะห์ความต้องการ และตอบจากจุดเดียว</p></div>;
  return detail.channel === "facebook_group" ? <GroupConversation detail={detail} runCommand={runCommand} onRefresh={onRefresh} commandsReady={commandsReady} composer={composer} /> : <MessengerConversation detail={detail} />;
}

function SentComment({ delivery, onSave, commandsReady }) {
  const shownText=delivery.editedText&&delivery.editState==="sent"?delivery.editedText:delivery.text;
  const [editing,setEditing]=useState(false),[text,setText]=useState(shownText??""),[busy,setBusy]=useState(false),[error,setError]=useState("");
  useEffect(()=>{setText(shownText??"");},[shownText]);
  async function save(){const next=text.trim();if(!next||next===shownText)return setEditing(false);setBusy(true);setError("");try{await onSave(delivery.id,next);setEditing(false);}catch{setError("แก้ไขบน Facebook ไม่สำเร็จ กรุณาตรวจ session แล้วลองอีกครั้ง");}finally{setBusy(false);}}
  return <article className="facebook-comment facebook-comment--rendar"><span className="inbox-avatar inbox-avatar--rendar" aria-hidden="true">R</span><div><div className="facebook-comment__bubble facebook-comment__bubble--rendar"><div className="rendar-comment-head"><strong>Rendar</strong><span><CheckCircle2 size={13}/>ส่งแล้ว</span></div>{editing?<><textarea aria-label="แก้ไขความคิดเห็นบน Facebook" value={text} maxLength={4000} onChange={(event)=>setText(event.target.value)}/><div className="rendar-edit-actions"><button type="button" onClick={()=>{setEditing(false);setText(shownText??"");setError("");}}>ยกเลิก</button><button type="button" disabled={busy||!text.trim()} onClick={save}>{busy?<LoaderCircle className="is-spinning" size={14}/>:<CheckCircle2 size={14}/>}บันทึกบน Facebook</button></div></>:<p>{shownText}</p>}</div><div className="facebook-comment__meta"><time>{formatDate(delivery.createdAt)} · ถูกใจ · ตอบกลับ</time>{!editing?<button type="button" disabled={!commandsReady||busy} onClick={()=>setEditing(true)}><Pencil size={12}/>แก้ไข</button>:null}{delivery.editState&&delivery.editState!=="sent"?<span className="facebook-edit-pending">กำลังตรวจสอบการแก้ไข</span>:null}</div>{error?<p className="facebook-edit-error" role="alert">{error}</p>:null}</div></article>;
}

function GroupConversation({ detail, runCommand, onRefresh, commandsReady, composer }) {
  const timeline = detail.timeline ?? [], explicitKinds = timeline.some((entry) => entry.kind);
  const targetOf = (entry) => entry?.isTarget === true || entry?.uiId === detail.target?.uiId;
  const post = pickGroupPost(timeline, detail.target?.uiId);
  const comments = explicitKinds ? timeline.filter((entry) => entry.kind === "comment") : timeline.filter((entry) => entry !== post),sent=(detail.deliveries??[]).filter(delivery=>delivery.state==="sent");
  const visibleCount=Math.max(post?.commentCount??0,comments.length+sent.length),reactionCount=post?.reactionCount??0;
  async function editSent(id,text){await runCommand("edit-delivered",{deliveryIntentId:id,text});await onRefresh();}
  return <article className="conversation conversation--group"><div className="facebook-livebar"><span><i/>Live · อัปเดต {detail.facebook?.observedAt?formatDate(detail.facebook.observedAt):"เมื่อสักครู่"}</span><span>{detail.facebook?.autoReply?<><CheckCircle2 size={14}/>ตอบอัตโนมัติ</>:"ตรวจสอบก่อนส่ง"}</span>{detail.facebook?.permalink?<a href={detail.facebook.permalink} target="_blank" rel="noreferrer">ดูโพสต์จริง <ExternalLink size={13}/></a>:null}</div><div className="facebook-thread-card"><div className="conversation-kicker"><UsersRound size={16} /><span>{detail.source?.name}</span></div>{post ? <section className={`facebook-post${targetOf(post) ? " is-reply-target" : ""}`}>{targetOf(post) ? <span className="reply-target-badge">กำลังตอบโพสต์นี้</span> : null}<header><span className="inbox-avatar" aria-hidden="true">{(post?.author ?? detail.participant?.label ?? "F").slice(0, 1)}</span><div><strong>{post?.author ?? detail.participant?.label}</strong><span>{formatDate(post?.createdAt ?? detail.createdAt)} · สมาชิกกลุ่ม</span></div><button type="button" aria-label="ตัวเลือกโพสต์"><MoreHorizontal size={20}/></button></header><p>{post?.text ?? detail.message?.text}</p><div className="facebook-post__counts"><span><i className="facebook-like-dot"><ThumbsUp size={11}/></i>{reactionCount.toLocaleString("th-TH")}</span><span>{visibleCount.toLocaleString("th-TH")} ความคิดเห็น</span></div><footer><button type="button"><ThumbsUp size={17}/>ถูกใจ</button><button type="button"><MessageCircleMore size={17}/>แสดงความคิดเห็น</button><button type="button"><Share2 size={17}/>แชร์</button></footer></section> : <p className="conversation-muted">โพสต์ต้นทางไม่อยู่ในข้อมูลที่บันทึกไว้</p>}<section className="facebook-comment-section" aria-label="ความคิดเห็นทั้งหมด"><header><h2>ความคิดเห็น</h2><span>เกี่ยวข้องมากที่สุด</span></header><div className="facebook-comments">{comments.map((comment) => <article className={`facebook-comment${targetOf(comment) ? " is-reply-target" : ""}`} key={comment.id}><span className="inbox-avatar inbox-avatar--comment" aria-hidden="true">{(comment.author ?? "F").slice(0, 1)}</span><div><div className="facebook-comment__bubble">{targetOf(comment) ? <span className="reply-target-badge">กำลังตอบความคิดเห็นนี้</span> : null}<strong>{comment.author ?? "สมาชิกกลุ่ม"}</strong><p>{comment.text}</p></div><time>{formatDate(comment.createdAt)} · ถูกใจ · ตอบกลับ</time></div></article>)}{sent.map(delivery=><SentComment key={delivery.id} delivery={delivery} onSave={editSent} commandsReady={commandsReady}/>)}{!comments.length&&!sent.length?<p className="conversation-muted">ยังไม่มีความคิดเห็น เป็นคนแรกที่แสดงความคิดเห็น</p>:null}</div>{composer}</section></div></article>;
}

function MessengerConversation({ detail }) {
  return <article className="conversation conversation--messenger"><div className="conversation-kicker"><MessageCircleMore size={16} />ข้อความจากเพจ</div><div className="messenger-thread">{(detail.timeline ?? []).map((message) => { const outbound = message.direction === "outbound"; return <div className={`messenger-message${outbound ? " is-outbound" : ""}`} key={message.id}><span>{message.author ?? (outbound ? "ทีม rendar" : detail.participant?.label)}</span><p>{message.text}</p><time>{formatDate(message.createdAt)}</time></div>; })}</div></article>;
}
