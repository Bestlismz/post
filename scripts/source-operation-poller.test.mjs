import assert from "node:assert/strict";
import test from "node:test";
import { createOperationPoller } from "../app/sources/operation-poller.mjs";

function fakeClock() {
  let instant = 0;
  let sequence = 0;
  const timers = new Map();
  return {
    now: () => instant,
    setTimer(callback, delay) {
      const id = ++sequence;
      timers.set(id, { at: instant + delay, callback });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
    pending: () => timers.size,
    async advance(milliseconds) {
      const target = instant + milliseconds;
      while (true) {
        const next = [...timers.entries()].sort((left, right) => left[1].at - right[1].at)[0];
        if (!next || next[1].at > target) break;
        instant = next[1].at;
        timers.delete(next[0]);
        await next[1].callback();
        await Promise.resolve();
      }
      instant = target;
      await Promise.resolve();
    },
  };
}

function harness(reload, options = {}) {
  const clock = fakeClock();
  const poller = createOperationPoller({
    reload,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    delays: [1_000, 2_000, 4_000, 8_000, 15_000, 30_000],
    ...options,
  });
  return { clock, poller };
}

test("operation polling observes a receipt arriving after the former 31 second cutoff", async () => {
  const seen = [];
  const { clock, poller } = harness(async (operationId) => {
    seen.push({ operationId, at: clock.now() });
    return clock.now() >= 35_000 ? "completed" : "queued";
  });
  poller.start("scan-late");
  await clock.advance(70_000);
  assert(seen.some(({ at }) => at > 31_000));
  assert.equal(seen.at(-1).operationId, "scan-late");
  assert.equal(clock.pending(), 0);
});

test("operation polling continues to the server ten minute stuck threshold", async () => {
  const { clock, poller } = harness(async () => clock.now() >= 600_000 ? "stuck" : "queued");
  poller.start("scan-stuck");
  await clock.advance(610_000);
  assert.equal(poller.state("scan-stuck"), "stuck");
  assert.equal(clock.pending(), 0);
});

test("a second operation starts a fresh lifecycle after the first exhausts", async () => {
  const calls = [];
  const { clock, poller } = harness(async (operationId) => {
    calls.push(operationId);
    return operationId === "scan-second" ? "completed" : "queued";
  }, { absoluteCapMs: 10_000 });
  poller.start("scan-first");
  await clock.advance(11_000);
  assert.equal(poller.state("scan-first"), "expired");
  poller.start("scan-second");
  await clock.advance(1_000);
  assert(calls.includes("scan-second"));
  assert.equal(poller.state("scan-second"), "completed");
});

test("a second operation starts fresh after the first reaches a terminal receipt", async () => {
  const calls = [];
  const { clock, poller } = harness(async (operationId) => { calls.push(operationId); return "completed"; });
  poller.start("scan-first");
  await clock.advance(1_000);
  poller.start("scan-second");
  await clock.advance(1_000);
  assert.deepEqual(calls, ["scan-first", "scan-second"]);
  assert.equal(poller.state("scan-second"), "completed");
  assert.equal(clock.pending(), 0);
});

test("transient reload failures back off and recover without abandoning the operation", async () => {
  let attempts = 0;
  const { clock, poller } = harness(async () => {
    attempts += 1;
    if (attempts <= 2) throw new Error("temporary network failure");
    return attempts >= 4 ? "completed" : "queued";
  });
  poller.start("scan-retry");
  await clock.advance(20_000);
  assert.equal(attempts, 4);
  assert.equal(poller.state("scan-retry"), "completed");
  assert.equal(clock.pending(), 0);
});

test("visibility and destroy always clean up pending timers", async () => {
  let visible = true;
  let visibilityListener;
  let attempts = 0;
  const { clock, poller } = harness(async () => { attempts += 1; return "queued"; }, {
    isVisible: () => visible,
    subscribeVisibility: (listener) => { visibilityListener = listener; return () => { visibilityListener = undefined; }; },
  });
  poller.start("scan-visible");
  visible = false;
  visibilityListener();
  assert.equal(clock.pending(), 0);
  await clock.advance(60_000);
  assert.equal(attempts, 0);
  visible = true;
  visibilityListener();
  await clock.advance(1_000);
  assert.equal(attempts, 1);
  poller.destroy();
  assert.equal(clock.pending(), 0);
  assert.equal(visibilityListener, undefined);
});
