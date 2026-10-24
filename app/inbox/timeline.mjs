export function pickGroupPost(timeline = [], targetUiId = null) {
  const explicitKinds = timeline.some((entry) => entry.kind);
  const posts = explicitKinds ? timeline.filter((entry) => entry.kind === "post") : timeline.slice(0, 1);
  return posts.find((entry) => entry.isTarget === true || (targetUiId && entry.uiId === targetUiId)) ?? posts.at(-1) ?? null;
}

export function visibleGroupComments(thread = [], deliveries = []) {
  const deliveredIds = new Set(deliveries.filter((delivery) => delivery.state === "sent" && delivery.providerMessageId).map((delivery) => delivery.providerMessageId));
  return thread.filter((entry) => entry.kind === "comment" && !deliveredIds.has(entry.commentId));
}

export function groupTargetBadge(detail, sentCount = 0) {
  const noun = detail?.target?.kind === "comment" ? "ความคิดเห็น" : "โพสต์";
  if (sentCount > 0 || detail?.workflow?.phase === "sent") return { label: "ตอบแล้ว", tone: "sent" };
  if (["queued", "sending", "reconciling"].includes(detail?.workflow?.phase)) return { label: "กำลังส่ง", tone: "pending" };
  return { label: `${noun}เป้าหมาย`, tone: "target" };
}
