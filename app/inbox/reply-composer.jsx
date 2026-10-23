"use client";

import { AlertTriangle, Check, LoaderCircle, Send, UserRoundPlus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

export function ReplyComposer({ detail, runCommand, onRefresh, commandsReady }) {
  const serverLatest = detail.replies?.[0] ?? null;
  const [activeReply, setActiveReply] = useState(serverLatest);
  const latest = activeReply;
  const [text, setText] = useState(serverLatest?.text ?? ""), [busy, setBusy] = useState(null), [notice, setNotice] = useState(null);
  const stale = detail.stale === true || detail.status === "superseded";
  const simulated = detail.deliveryCapability?.externalSend === false;
  const latestDelivery = detail.deliveries?.[0] ?? null, unresolved = latestDelivery?.state === "unknown";
  useEffect(() => { setActiveReply(serverLatest); setText(serverLatest?.text ?? ""); }, [detail.id, serverLatest?.id, serverLatest?.text]);
  useEffect(() => { setNotice(null); }, [detail.id]);
  const changed = latest && text.trim() !== latest.text, canApprove = commandsReady && !stale && !busy && !latestDelivery && Boolean(latest) && text.trim().length > 0;
  const label = detail.channel === "facebook_group" ? detail.target?.kind === "post" ? "แสดงความคิดเห็นใต้โพสต์" : "ตอบกลับความคิดเห็น" : "ตอบกลับใน Messenger", count = useMemo(() => [...text].length, [text]);

  async function approve() {
    if (!canApprove) return; setBusy("approve"); setNotice(null);
    try {
      let replyId = latest.id;
      if (changed) { const edited = await runCommand("edit", { replyId, text: text.trim() }); const adopted = edited?.reply ?? edited; replyId = adopted?.id; if (!replyId) throw new Error("Missing edited reply ID"); setActiveReply(adopted); setText(adopted.text); }
      const result = await runCommand("approve", { replyId });
      const isSimulation = simulated || result?.operation?.simulated === true;
      setNotice({ kind: "success", text: isSimulation ? "บันทึกผลในโหมดเดโมแล้ว — ยังไม่ได้ส่งไป Facebook" : changed ? "บันทึกและอนุมัติแล้ว กำลังส่ง — รอยืนยันจาก Facebook" : "อนุมัติแล้ว กำลังส่ง — รอยืนยันจาก Facebook" }); await onRefresh();
    } catch (error) { setNotice({ kind: "error", text: error?.status === 409 ? "ข้อมูลเปลี่ยนแล้ว กรุณาโหลดฉบับล่าสุดก่อนอนุมัติ" : "ดำเนินการไม่สำเร็จ กรุณาลองอีกครั้ง" }); }
    finally { setBusy(null); }
  }
  async function prepare() { setBusy("prepare"); setNotice(null); try { await runCommand("prepare"); setNotice({ kind: "success", text: "รับงานแล้ว กำลังเตรียมคำตอบจากข้อมูลห้องปัจจุบัน" }); await onRefresh(); } catch { setNotice({ kind: "error", text: "เริ่มเตรียมคำตอบไม่ได้ กรุณาลองอีกครั้ง" }); } finally { setBusy(null); } }
  async function handoff() { setBusy("handoff"); setNotice(null); try { await runCommand("handoff", { reason: "ผู้ดูแลรับช่วงจาก Inbox Workspace" }); setNotice({ kind: "success", text: "ส่งต่อให้ทีมแล้ว ระบบอัตโนมัติจะไม่ตอบรายการนี้" }); await onRefresh(); } catch { setNotice({ kind: "error", text: "ส่งต่อให้ทีมไม่ได้ กรุณาลองอีกครั้ง" }); } finally { setBusy(null); } }
  async function retry() { if (!unresolved || busy) return; setBusy("retry"); setNotice(null); try { await runCommand("retry", { deliveryIntentId: latestDelivery.id }); setNotice({ kind: "success", text: "ยืนยันว่าไม่พบคอมเมนต์แล้ว — สร้างงานส่งใหม่พร้อมบันทึก audit แล้ว" }); await onRefresh(); } catch { setNotice({ kind: "error", text: "สร้างงานส่งใหม่ไม่ได้ กรุณาตรวจสถานะ Facebook แล้วลองอีกครั้ง" }); } finally { setBusy(null); } }

  return <section className="reply-composer" aria-label="เขียนคำตอบ"><header><strong>{label}</strong><span>{latest ? `ฉบับที่ ${latest.version}` : text.trim() ? "ร่างที่ยังไม่บันทึก" : "ยังไม่มีร่างคำตอบ"}</span></header>{simulated ? <div className="composer-simulation" role="note"><AlertTriangle size={17} /><div><strong>โหมดสาธิต</strong><span>การอนุมัติจะบันทึกในระบบนี้เท่านั้น และจะไม่ส่งไป Facebook</span></div></div> : null}{stale ? <div className="composer-stale" role="alert"><AlertTriangle size={17} /><div><strong>พิมพ์ร่างไว้ได้ แต่ยังส่งไม่ได้</strong><span>{detail.staleReason ?? "มีข้อความหรือข้อมูลห้องที่ใหม่กว่า กรุณาโหลดข้อมูลล่าสุดก่อนส่ง"}</span></div></div> : null}{unresolved ? <div className="composer-stale" role="alert"><AlertTriangle size={17} /><div><strong>Facebook ยังไม่ยืนยันผลการส่งครั้งก่อน</strong><span>ตรวจโพสต์จริงก่อนเสมอ หากไม่พบคอมเมนต์จึงค่อยกดส่งใหม่ด้านล่าง</span></div></div> : null}<div className="composer-input"><textarea aria-label="ข้อความตอบกลับ" placeholder={stale ? "พิมพ์ร่างไว้ก่อนได้ ระบบจะยังไม่ส่งจนกว่าจะโหลดข้อมูลล่าสุด…" : "พิมพ์คำตอบ หรือให้ระบบเตรียมจากข้อมูลห้องปัจจุบัน…"} value={text} onChange={(event) => setText(event.target.value)} disabled={Boolean(busy)||Boolean(latestDelivery)} maxLength={4000} /><span>{count.toLocaleString("th-TH")} / 4,000</span></div><footer><button className="composer-handoff" type="button" onClick={handoff} disabled={!commandsReady || stale || Boolean(busy)}><UserRoundPlus size={17} />ส่งให้ทีมดูแล</button><div>{!latest ? <button className="composer-primary" type="button" onClick={prepare} disabled={!commandsReady || stale || Boolean(busy)}>{busy === "prepare" ? <LoaderCircle className="is-spinning" size={18} /> : <Check size={18} />}{stale ? "โหลดข้อมูลล่าสุดก่อนส่ง" : "เตรียมคำตอบด้วย AI"}</button> : null}{latest && unresolved ? <button className="composer-primary" type="button" onClick={retry} disabled={!commandsReady || Boolean(busy)}>{busy === "retry" ? <LoaderCircle className="is-spinning" size={18} /> : <Send size={18} />}ตรวจแล้วว่าไม่พบ — ส่งใหม่</button> : null}{latest && !latestDelivery ? <button className="composer-primary" type="button" onClick={approve} disabled={!canApprove}>{busy === "approve" ? <LoaderCircle className="is-spinning" size={18} /> : <Send size={18} />}{simulated ? "อนุมัติในเดโม" : "อนุมัติและส่ง"}</button> : null}</div></footer>{notice ? <p className={`composer-notice composer-notice--${notice.kind}`} role="status">{notice.text}</p> : null}</section>;
}
