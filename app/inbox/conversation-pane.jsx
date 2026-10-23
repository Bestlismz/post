import { MessageCircleMore, RefreshCw, ThumbsUp, UsersRound } from "lucide-react";

function formatDate(value) {
  const date = new Date(value); if (!Number.isFinite(date.valueOf())) return "";
  return new Intl.DateTimeFormat("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" }).format(date);
}

export function ConversationPane({ detail, loading, error, onRetry }) {
  if (loading && !detail) return <div className="conversation-skeleton" aria-label="กำลังโหลดรายละเอียด"><i /><i /><i /><i /></div>;
  if (error) return <div className="inbox-detail-error" role="alert"><div><RefreshCw size={24} /><strong>โหลดรายละเอียดส่วนนี้ไม่ได้</strong><p>คิวด้านซ้ายยังใช้งานได้ตามปกติ กรุณาลองเฉพาะรายละเอียดอีกครั้ง</p></div><button type="button" onClick={onRetry}><RefreshCw size={17} />ลองโหลดรายละเอียดอีกครั้ง</button></div>;
  if (!detail) return <div className="inbox-no-selection"><MessageCircleMore size={30} /><strong>เลือกข้อความเพื่อเริ่มทำงาน</strong><p>ดูบริบท วิเคราะห์ความต้องการ และตอบจากจุดเดียว</p></div>;
  return detail.channel === "facebook_group" ? <GroupConversation detail={detail} /> : <MessengerConversation detail={detail} />;
}

function GroupConversation({ detail }) {
  const timeline = detail.timeline ?? [], explicitKinds = timeline.some((entry) => entry.kind);
  const post = timeline.find((entry) => entry.kind === "post") ?? (!explicitKinds ? timeline[0] : null);
  const comments = explicitKinds ? timeline.filter((entry) => entry.kind === "comment") : timeline.filter((entry) => entry !== post);
  const targetOf = (entry) => entry?.isTarget === true || entry?.uiId === detail.target?.uiId;
  return <article className="conversation conversation--group"><div className="conversation-kicker"><UsersRound size={16} />โพสต์จากกลุ่ม</div>{post ? <section className={`facebook-post${targetOf(post) ? " is-reply-target" : ""}`}>{targetOf(post) ? <span className="reply-target-badge">เป้าหมายตอบกลับ</span> : null}<header><span className="inbox-avatar" aria-hidden="true">{(post?.author ?? detail.participant?.label ?? "F").slice(0, 1)}</span><div><strong>{post?.author ?? detail.participant?.label}</strong><span>{detail.source?.name} · {formatDate(post?.createdAt ?? detail.createdAt)}</span></div></header><p>{post?.text ?? detail.message?.text}</p><footer><span><ThumbsUp size={16} />32</span><span><MessageCircleMore size={16} />{comments.length} ความคิดเห็น</span></footer></section> : <p className="conversation-muted">โพสต์ต้นทางไม่อยู่ในข้อมูลที่บันทึกไว้</p>}<h2>ความคิดเห็นทั้งหมด ({comments.length})</h2><div className="facebook-comments">{comments.length ? comments.map((comment) => <article className={`facebook-comment${targetOf(comment) ? " is-reply-target" : ""}`} key={comment.id}><span className="inbox-avatar inbox-avatar--comment" aria-hidden="true">{(comment.author ?? "F").slice(0, 1)}</span><div><div className="facebook-comment__bubble">{targetOf(comment) ? <span className="reply-target-badge">เป้าหมายตอบกลับ</span> : null}<strong>{comment.author ?? "สมาชิกกลุ่ม"}</strong><p>{comment.text}</p></div><time>{formatDate(comment.createdAt)} · ถูกใจ · ตอบกลับ</time></div></article>) : <p className="conversation-muted">โพสต์นี้ยังไม่มีความคิดเห็นอื่น</p>}</div></article>;
}

function MessengerConversation({ detail }) {
  return <article className="conversation conversation--messenger"><div className="conversation-kicker"><MessageCircleMore size={16} />ข้อความจากเพจ</div><div className="messenger-thread">{(detail.timeline ?? []).map((message) => { const outbound = message.direction === "outbound"; return <div className={`messenger-message${outbound ? " is-outbound" : ""}`} key={message.id}><span>{message.author ?? (outbound ? "ทีม rendar" : detail.participant?.label)}</span><p>{message.text}</p><time>{formatDate(message.createdAt)}</time></div>; })}</div></article>;
}
