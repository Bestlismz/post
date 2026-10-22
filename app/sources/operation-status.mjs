export function operationStatusReducer(state, action) {
  if (action.type === "retry_required") {
    if (state[action.operationId]?.sourceId === action.sourceId && state[action.operationId]?.state === "retry_required") return state;
    return { ...state, [action.operationId]: { sourceId: action.sourceId, state: "retry_required" } };
  }
  if (action.type === "retry_started") {
    if (!state[action.operationId] || state[action.operationId].state === "retrying") return state;
    return { ...state, [action.operationId]: { ...state[action.operationId], state: "retrying" } };
  }
  if (action.type === "retry_succeeded") {
    if (state[action.operationId]?.state !== "retrying") return state;
    const next = { ...state };
    delete next[action.operationId];
    return next;
  }
  if (action.type === "reconcile") {
    const current = new Map(action.groups.map((source) => [source.id, source.latestOperation]));
    const next = Object.fromEntries(Object.entries(state).filter(([operationId, issue]) => {
      const operation = current.get(issue.sourceId);
      return operation?.operationId === operationId && operation.state === "queued";
    }));
    const unchanged = Object.keys(next).length === Object.keys(state).length && Object.keys(next).every((key) => next[key] === state[key]);
    return unchanged ? state : next;
  }
  return state;
}
