export function conversationId(target) {
  return JSON.stringify([target.groupId, target.postId]);
}

export function buildConversationOptions(workspace) {
  const groups = new Map((workspace.groups ?? []).map((group) => [group.id, group.name || `Group ${group.id}`]));
  const seen = new Set();
  return workspace.targets.flatMap((target) => {
    const id = conversationId(target);
    if (seen.has(id)) return [];
    seen.add(id);
    const post = workspace.targets.find((item) => conversationId(item) === id && item.kind === "post");
    return [{ id, groupId: target.groupId, groupLabel: groups.get(target.groupId) || `Group ${target.groupId}`, targetKey: (post ?? target).key, label: `${post?.author || "Original post"} · ${(post?.text || target.postText || "Post context").slice(0, 85)}` }];
  });
}

export function resolveConversationTargetKey(options, targets, selectedTargetKey) {
  if (selectedTargetKey && targets.some((target) => target.key === selectedTargetKey)) return selectedTargetKey;
  return options[0]?.targetKey ?? null;
}

export function buildConversation(workspace, selectedTargetKey) {
  const selectedTarget = workspace.targets.find((target) => target.key === selectedTargetKey);
  if (!selectedTarget) return null;
  const id = conversationId(selectedTarget);
  const siblings = workspace.targets.filter((target) => conversationId(target) === id);
  const post = siblings.find((target) => target.kind === "post");
  const group = workspace.groups?.find((item) => item.id === selectedTarget.groupId);
  const submissions = new Map(workspace.submissions.map((submission) => [submission.targetKey, submission]));
  const seen = new Set();
  const comments = siblings.flatMap((target) => {
    if (target.kind !== "comment" || seen.has(target.key)) return [];
    seen.add(target.key);
    return [{ target, submission: submissions.get(target.key) ?? null }];
  });
  const context = siblings.map((target) => target.postText).find((text) => text && text !== "Open the Facebook permalink to view the parent post.") || "";
  return {
    id,
    group: { id: selectedTarget.groupId, label: group?.name || `Group ${selectedTarget.groupId}` },
    sourceUrl: post?.url || selectedTarget.url,
    post: post ? { kind: "captured", target: post, author: post.author, text: post.text } : { kind: "context", target: null, author: null, text: context },
    comments,
    selectedTarget,
    postSubmission: post ? submissions.get(post.key) ?? null : null,
  };
}
