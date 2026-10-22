export function submissionPolicy(runtime, target) {
  if (target?.demo) return "demo";
  if (runtime.mode === "live" && !runtime.liveSubmissionEnabled) return "blocked";
  if (target?.channel === "facebook_group" && (target.allowListed !== true || target.sourceHealth !== "connected")) return "blocked";
  return "remote";
}
