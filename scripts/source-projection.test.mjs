import assert from "node:assert/strict";
import test from "node:test";
import { nextScheduleCheckWithinMinutes, operationState } from "../src/sources/projection.mjs";

test("source operation projection preserves real terminal and running job states before age fallback", () => {
  assert.equal(operationState({ operation_stuck: true, operation_job_status: "failed" }), "failed");
  assert.equal(operationState({ operation_stuck: true, operation_job_status: "running" }), "running");
  assert.equal(operationState({ operation_stuck: true, operation_job_status: "pending" }), "stuck");
  assert.equal(operationState({ operation_stuck: true, operation_job_status: "completed" }), "stuck");
  assert.equal(operationState({ operation_completed: true, operation_stuck: true, operation_job_status: "failed" }), "completed");
});

test("source schedule projection reports only a truthful evaluation bound", () => {
  assert.equal(nextScheduleCheckWithinMinutes({ schedule_revision: 1, schedule_enabled: true, schedule_cadence_minutes: 15 }), 15);
  assert.equal(nextScheduleCheckWithinMinutes({ schedule_revision: 1, schedule_enabled: false, schedule_cadence_minutes: 15 }), null);
  assert.equal(nextScheduleCheckWithinMinutes({ schedule_revision: null, schedule_enabled: true, schedule_cadence_minutes: 15 }), null);
});
