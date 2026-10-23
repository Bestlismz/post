export function pickGroupPost(timeline = [], targetUiId = null) {
  const explicitKinds = timeline.some((entry) => entry.kind);
  const posts = explicitKinds ? timeline.filter((entry) => entry.kind === "post") : timeline.slice(0, 1);
  return posts.find((entry) => entry.isTarget === true || (targetUiId && entry.uiId === targetUiId)) ?? posts.at(-1) ?? null;
}
