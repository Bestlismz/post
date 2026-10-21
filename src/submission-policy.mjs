export function submissionPolicy(runtime, target) {
  if (target?.demo) return "demo";
  if (runtime.mode === "live" && !runtime.liveSubmissionEnabled) return "blocked";
  return "remote";
}
