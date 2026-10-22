const terminalStates = new Set(["completed", "complete", "stuck", "replaced", "failed", "cancelled"]);

export function createOperationPoller({
  reload,
  now = Date.now,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
  isVisible = () => typeof document === "undefined" || document.visibilityState === "visible",
  subscribeVisibility = (listener) => {
    if (typeof document === "undefined") return () => {};
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  },
  delays = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000],
  absoluteCapMs = 12 * 60_000,
}) {
  let active = null;
  let timer = null;
  let destroyed = false;
  const states = new Map();

  function clearPending() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  function schedule() {
    clearPending();
    if (destroyed || !active || !isVisible()) return;
    const elapsed = now() - active.startedAt;
    if (elapsed >= absoluteCapMs) {
      states.set(active.id, "expired");
      active = null;
      return;
    }
    const backoff = delays[Math.min(active.attempt, delays.length - 1)];
    timer = setTimer(tick, Math.min(backoff, absoluteCapMs - elapsed));
  }

  async function tick() {
    timer = null;
    if (destroyed || !active || !isVisible()) return;
    if (now() - active.startedAt >= absoluteCapMs) {
      states.set(active.id, "expired");
      active = null;
      return;
    }
    const operation = active;
    try {
      const state = await reload(operation.id);
      if (destroyed || active !== operation) return;
      states.set(operation.id, state ?? "queued");
      if (terminalStates.has(state)) {
        active = null;
        return;
      }
    } catch {
      if (destroyed || active !== operation) return;
    }
    operation.attempt += 1;
    schedule();
  }

  function start(operationId) {
    if (destroyed || !operationId || active?.id === operationId) return;
    clearPending();
    active = { id: operationId, attempt: 0, startedAt: now() };
    states.set(operationId, "queued");
    schedule();
  }

  function stop(operationId) {
    if (!active || (operationId && active.id !== operationId)) return;
    clearPending();
    active = null;
  }

  const unsubscribe = subscribeVisibility(() => {
    if (destroyed) return;
    if (!isVisible()) clearPending();
    else schedule();
  });

  return {
    start,
    stop,
    state: (operationId) => states.get(operationId),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearPending();
      active = null;
      unsubscribe();
    },
  };
}
