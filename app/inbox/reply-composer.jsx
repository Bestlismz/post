"use client";

import { AlertTriangle, Check, LoaderCircle, RefreshCw, Send, UserRoundPlus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

const errorMessage = (error, fallback) => ({
  CONVERSATION_SUPERSEDED: "มีรายการใหม่กว่าแล้ว เปิดรายการล่าสุดเพื่อทำงานต่อ",
  HUMAN_TAKEOVER: "รายการนี้อยู่กับทีมดูแล กดกลับมาให้ระบบก่อนทำงานต่อ",
  INVENTORY_CHANGED: "ข้อมูลห้องเปลี่ยนแล้ว กรุณาเตรียมคำตอบใหม่",
  POLICY_CHANGED: "นโยบายเปลี่ยนแล้ว กรุณาเตรียมคำตอบใหม่",
  PROFILE_CHANGED: "ข้อมูลธุรกิจเปลี่ยนแล้ว กรุณาเตรียมคำตอบใหม่",
  FORMAT_CHANGED: "รูปแบบคำตอบเปลี่ยนแล้ว กรุณาเตรียมคำตอบใหม่",
  SOURCE_CHANGED: "การเชื่อมต่อ Facebook เปลี่ยนแล้ว กรุณาตรวจแหล่งข้อมูล",
  FACEBOOK_RESULT_UNKNOWN: "ต้องตรวจผลบน Facebook ให้แน่ชัดก่อนส่งอีกครั้ง",
}[error?.code] ?? fallback);

export function ReplyComposer({ detail, runCommand, commandsReady }) {
  const workflow = detail.workflow ?? { phase: "observed", actions: [] };
  const hasAction = (name) => workflow.actions?.includes(name);
  const serverLatest = detail.replies?.[0] ?? null;
  const [activeReply, setActiveReply] = useState(serverLatest);
  const latest = activeReply;
  const [text, setText] = useState(serverLatest?.text ?? ""), [busy, setBusy] = useState(null), [notice, setNotice] = useState(null);
  const simulated = detail.deliveryCapability?.externalSend === false;
  const latestDelivery = detail.deliveries?.[0] ?? null;
  useEffect(() => { setActiveReply(serverLatest); setText(serverLatest?.text ?? ""); }, [detail.id, serverLatest?.id, serverLatest?.text]);
  useEffect(() => { setNotice(null); }, [detail.id, workflow.phase]);
  const changed = latest && text.trim() !== latest.text;
  const canApprove = commandsReady && hasAction("approve") && !busy && Boolean(latest) && text.trim().length > 0;
  const label = detail.channel === "facebook_group" ? detail.target?.kind === "post" ? "แสดงความคิดเห็นใต้โพสต์" : "ตอบกลับความคิดเห็น" : "ตอบกลับใน Messenger";
  const count = useMemo(() => [...text].length, [text]);

  async function act(name, command, success, fallback, input = {}) {
    if (busy) return;
    setBusy(name); setNotice(null);
    try { await runCommand(command, input); setNotice({ kind: "success", text: success }); }
    catch (error) { setNotice({ kind: "error", text: errorMessage(error, fallback) }); }
    finally { setBusy(null); }
  }

  async function approve() {
    if (!canApprove) return;
    setBusy("approve"); setNotice(null);
    try {
      let replyId = latest.id;
      if (changed) {
        const edited = await runCommand("edit", { replyId, text: text.trim() });
        const adopted = edited?.reply ?? edited;
        replyId = adopted?.id;
        if (!replyId) throw new Error("Missing edited reply ID");
        setActiveReply(adopted); setText(adopted.text);
      }
      const result = await runCommand("approve", { replyId });
      const isSimulation = simulated || result?.operation?.simulated === true;
      setNotice({ kind: "success", text: isSimulation ? "บันทึกผลในโหมดเดโมแล้ว — ยังไม่ได้ส่งไป Facebook" : "อนุมัติแล้ว ระบบกำลังส่งและตรวจผลบน Facebook" });
    } catch (error) { setNotice({ kind: "error", text: errorMessage(error, "อนุมัติไม่สำเร็จ กรุณาลองอีกครั้ง") }); }
    finally { setBusy(null); }
  }

  const statusIsBlocking = ["superseded", "draft_stale", "handed_off", "reconciling", "send_failed", "analyzing", "queued", "sending"].includes(workflow.phase);
  const blockingDetail = workflow.phase === "superseded" ? "โพสต์หรือความคิดเห็นนี้มีฉบับใหม่กว่า"
    : workflow.phase === "draft_stale" ? errorMessage({ code: workflow.reason }, "ข้อมูลที่ใช้สร้างคำตอบเปลี่ยนแล้ว กรุณาเตรียมคำตอบใหม่")
    : workflow.phase === "handed_off" ? "ระบบอัตโนมัติหยุดรายการนี้จนกว่าจะนำกลับ"
    : workflow.phase === "reconciling" ? "ยังส่งซ้ำไม่ได้จนกว่าจะตรวจว่าไม่มีคอมเมนต์บน Facebook"
    : workflow.reason === "DELIVERY_CANCELLED" ? "รายการส่งถูกยกเลิกก่อนเริ่มส่ง สามารถนำกลับเข้าคิวได้"
    : workflow.phase === "send_failed" ? "การส่งครั้งล่าสุดล้มเหลว สามารถลองส่งใหม่ได้อย่างปลอดภัย"
    : "สถานะจะอัปเดตอัตโนมัติเมื่อขั้นตอนนี้เสร็จ";
  return <section className="reply-composer" aria-label="เขียนคำตอบ">
    <header><strong>{label}</strong><span className={`workflow-pill workflow-pill--${workflow.tone ?? "neutral"}`}>{workflow.label}</span></header>
    {simulated ? <div className="composer-simulation" role="note"><AlertTriangle size={17} /><div><strong>โหมดสาธิต</strong><span>การอนุมัติจะบันทึกในระบบนี้เท่านั้น และจะไม่ส่งไป Facebook</span></div></div> : null}
    {statusIsBlocking ? <div className={workflow.tone === "danger" || workflow.phase === "draft_stale" ? "composer-stale" : "composer-workflow"} role="status"><AlertTriangle size={17} /><div><strong>{workflow.label}</strong><span>{blockingDetail}</span></div></div> : null}
    {latest ? <div className="composer-input"><textarea aria-label="ข้อความตอบกลับ" value={text} onChange={(event) => setText(event.target.value)} disabled={Boolean(busy) || !hasAction("approve")} maxLength={4000} /><span>{count.toLocaleString("th-TH")} / 4,000</span></div> : null}
    <footer>
      <div>{hasAction("handoff") ? <button className="composer-handoff" type="button" onClick={() => act("handoff", "handoff", "ส่งต่อให้ทีมแล้ว ระบบอัตโนมัติจะหยุดรายการนี้", "ส่งต่อให้ทีมไม่ได้ กรุณาลองอีกครั้ง", { reason: "ผู้ดูแลรับช่วงจาก Inbox Workspace" })} disabled={!commandsReady || Boolean(busy)}><UserRoundPlus size={17} />ส่งให้ทีมดูแล</button> : null}</div>
      <div>
        {hasAction("open_successor") ? <button className="composer-primary" type="button" onClick={() => runCommand("open-successor")}><RefreshCw size={18} />เปิดรายการล่าสุด</button> : null}
        {hasAction("resume") ? <button className="composer-primary" type="button" onClick={() => act("resume", "resume", "นำรายการกลับมาแล้ว", "นำรายการกลับจากทีมไม่ได้ กรุณาลองอีกครั้ง")} disabled={!commandsReady || Boolean(busy)}>{busy === "resume" ? <LoaderCircle className="is-spinning" size={18} /> : <RefreshCw size={18} />}นำกลับให้ระบบ</button> : null}
        {hasAction("prepare") ? <button className="composer-primary" type="button" onClick={() => act("prepare", "prepare", "รับงานแล้ว กำลังเตรียมคำตอบจากข้อมูลห้องปัจจุบัน", "เริ่มเตรียมคำตอบไม่ได้ กรุณาลองอีกครั้ง")} disabled={!commandsReady || Boolean(busy)}>{busy === "prepare" ? <LoaderCircle className="is-spinning" size={18} /> : <Check size={18} />}เตรียมคำตอบ</button> : null}
        {hasAction("verify_absent_and_retry") ? <button className="composer-primary" type="button" onClick={() => act("retry", "retry", "ยืนยันว่าไม่พบคอมเมนต์แล้ว ระบบกำลังส่งใหม่", "สร้างงานส่งใหม่ไม่ได้ กรุณาตรวจ Facebook แล้วลองอีกครั้ง", { deliveryIntentId: latestDelivery?.id })} disabled={!commandsReady || Boolean(busy)}>{busy === "retry" ? <LoaderCircle className="is-spinning" size={18} /> : <Send size={18} />}ตรวจแล้วว่าไม่พบ — ส่งใหม่</button> : null}
        {hasAction("retry_failed_delivery") ? <button className="composer-primary" type="button" onClick={() => act("retry-failed", "retry-failed", "สร้างคิวส่งใหม่แล้ว", "ลองส่งใหม่ไม่ได้ กรุณาตรวจการเชื่อมต่อ", { deliveryIntentId: latestDelivery?.id })} disabled={!commandsReady || Boolean(busy)}>{busy === "retry-failed" ? <LoaderCircle className="is-spinning" size={18} /> : <RefreshCw size={18} />}ลองส่งอีกครั้ง</button> : null}
        {hasAction("retry_cancelled_delivery") ? <button className="composer-primary" type="button" onClick={() => act("retry-cancelled", "retry-cancelled", "นำรายการกลับเข้าคิวส่งแล้ว", "นำรายการกลับเข้าคิวไม่ได้ กรุณาลองอีกครั้ง", { deliveryIntentId: latestDelivery?.id })} disabled={!commandsReady || Boolean(busy)}>{busy === "retry-cancelled" ? <LoaderCircle className="is-spinning" size={18} /> : <RefreshCw size={18} />}นำกลับเข้าคิว</button> : null}
        {hasAction("approve") ? <button className="composer-primary" type="button" onClick={approve} disabled={!canApprove}>{busy === "approve" ? <LoaderCircle className="is-spinning" size={18} /> : <Send size={18} />}{simulated ? "อนุมัติในเดโม" : "อนุมัติและส่ง"}</button> : null}
      </div>
    </footer>
    {notice ? <p className={`composer-notice composer-notice--${notice.kind}`} role="status">{notice.text}</p> : null}
  </section>;
}
