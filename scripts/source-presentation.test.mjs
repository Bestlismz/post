import assert from "node:assert/strict";
import test from "node:test";
import { primarySourceAction, scanPresentation, sourceReadiness } from "../app/sources/source-presentation.mjs";

const ready = { paused: false, health: { session: "healthy", selector: "healthy", sessionCircuit: false, selectorCircuit: false }, latestOperation: null, latestReceipt: null };

test("source presentation separates connection readiness from scan execution", () => {
  assert.equal(sourceReadiness(ready).state, "ready");
  assert.equal(scanPresentation(ready).state, "never");
  assert.deepEqual(primarySourceAction(ready), { id: "scan", label: "สแกนตอนนี้", disabled: false });

  const running = { ...ready, latestOperation: { state: "running", attempts: 2 } };
  assert.equal(scanPresentation(running).detail, "worker รับงานแล้ว · ครั้งที่ 2");
  assert.equal(primarySourceAction(running).id, "progress");
});

test("failed jobs and recovered sessions expose exactly one useful next action", () => {
  const failed = { ...ready, latestOperation: { state: "failed", reason: "WORKER_FAILED" } };
  assert.equal(scanPresentation(failed).label, "สแกนไม่สำเร็จ");
  assert.deepEqual(primarySourceAction(failed), { id: "scan", label: "ลองสแกนใหม่", disabled: false });

  const paused = { ...ready, paused: true };
  assert.deepEqual(primarySourceAction(paused), { id: "resume", label: "เปิดใช้งานและสแกนทดสอบ", disabled: false });
  assert.deepEqual(primarySourceAction(paused, { recoveryReady: true }), { id: "resume", label: "ยืนยันและสแกนทดสอบ", disabled: false });
});

test("scan receipt explains coverage, accepted item count and a safe reason", () => {
  const source = { ...ready, latestOperation: { state: "completed" }, latestReceipt: { coverage: "partial", health: "auth_required", reason: "session_lost", acceptedCount: 3 } };
  assert.deepEqual(scanPresentation(source), {
    state: "completed_with_issue",
    tone: "bad",
    label: "สแกนล่าสุดต้องตรวจสอบ",
    detail: "ครอบคลุมบางส่วน · พบ 3 รายการ · Facebook session หลุดระหว่างสแกน",
  });
});

test("paused sources with unhealthy sessions always offer recovery", () => {
  for (const health of [
    { session: "auth_required", selector: "healthy", sessionCircuit: true, selectorCircuit: false },
    { session: "healthy", selector: "changed", sessionCircuit: false, selectorCircuit: true },
    { session: "unknown", selector: "unknown", sessionCircuit: false, selectorCircuit: false },
  ]) {
    const source = { ...ready, paused: true, health };
    assert.equal(sourceReadiness(source).state, "paused");
    assert.deepEqual(primarySourceAction(source), { id: "recover", label: "กู้คืนการเชื่อมต่อ", disabled: false });
  }
});

test("new unverified groups can run their first scan without entering recovery", () => {
  const source = { ...ready, health: { session: "unknown", selector: "unknown", sessionCircuit: false, selectorCircuit: false } };
  assert.equal(sourceReadiness(source).state, "unverified");
  assert.deepEqual(primarySourceAction(source), { id: "scan", label: "สแกนครั้งแรก", disabled: false });
  assert.equal(primarySourceAction({ ...source, health: { ...source.health, sessionCircuit: true } }).id, "recover");
  assert.equal(primarySourceAction({ ...source, latestOperation: { state: "failed" } }).id, "recover");
});
