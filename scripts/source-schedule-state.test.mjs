import assert from "node:assert/strict";
import test from "node:test";
import { applySavedSchedule } from "../app/sources/schedule-state.mjs";

test("a saved cadence updates both the control and its visible next-check bound", () => {
  const groups = [
    { id: "source-1", name: "first", schedule: { cadenceMinutes: 15, revision: 1 }, nextScheduleCheckWithinMinutes: 15 },
    { id: "source-2", name: "second", schedule: { cadenceMinutes: 15, revision: 1 }, nextScheduleCheckWithinMinutes: 15 },
  ];
  const updated = applySavedSchedule(groups, "source-1", {
    schedule: { enabled: true, cadenceMinutes: 30 },
    revision: 2,
  });

  assert.deepEqual(updated[0], {
    id: "source-1",
    name: "first",
    schedule: { enabled: true, cadenceMinutes: 30, revision: 2 },
    nextScheduleCheckWithinMinutes: 30,
  });
  assert.equal(updated[1], groups[1]);
});

test("disabling a saved schedule immediately projects the next check as off", () => {
  const [updated] = applySavedSchedule(
    [{ id: "source-1", schedule: { enabled: true, cadenceMinutes: 15 }, nextScheduleCheckWithinMinutes: 15 }],
    "source-1",
    { schedule: { enabled: false, cadenceMinutes: 15 }, revision: 3 },
  );
  assert.equal(updated.nextScheduleCheckWithinMinutes, null);
});
