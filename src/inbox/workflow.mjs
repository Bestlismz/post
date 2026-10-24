const presentation = {
  observed: ["neutral", "รอเตรียมคำตอบ"],
  observing: ["neutral", "ติดตามเท่านั้น"],
  draft_stale: ["warning", "ต้องเตรียมคำตอบใหม่"],
  analyzing: ["info", "กำลังวิเคราะห์"],
  review_required: ["warning", "รอตรวจคำตอบ"],
  queued: ["info", "เข้าคิวส่งแล้ว"],
  sending: ["info", "กำลังส่ง"],
  reconciling: ["warning", "รอตรวจผลบน Facebook"],
  sent: ["success", "ส่งแล้ว"],
  send_failed: ["danger", "ส่งไม่สำเร็จ"],
  handed_off: ["neutral", "ทีมดูแลรับช่วง"],
  superseded: ["neutral", "มีรายการใหม่กว่า"],
};

export function projectWorkItemWorkflow(facts) {
  const delivery = facts.latestDelivery;
  let phase;
  let reason = null;
  let actions;

  if (delivery?.state === "sent") {
    phase = "sent";
    reason = delivery.editState === "failed" ? "EDIT_FAILED" : null;
    actions = ["edit_sent_comment"];
  } else if (facts.status === "superseded") {
    phase = "superseded";
    reason = "CONVERSATION_SUPERSEDED";
    actions = facts.successorId ? ["open_successor"] : [];
  } else if (facts.humanTakeover || facts.status === "handoff") {
    phase = "handed_off";
    reason = "HUMAN_TAKEOVER";
    actions = ["resume"];
  } else if (delivery?.state === "unknown" || delivery?.state === "attempting" && delivery?.outcomeCode) {
    phase = "reconciling";
    reason = "FACEBOOK_RESULT_UNKNOWN";
    actions = facts.channel === "facebook_group" && delivery?.outcomeCode === "RECONCILIATION_NOT_FOUND" ? ["verify_absent_and_retry"] : [];
  } else if (delivery?.state === "attempting") {
    phase = "sending";
    actions = [];
  } else if (delivery?.state === "queued") {
    phase = "queued";
    actions = ["handoff"];
  } else if (facts.activeAnalysis || facts.status === "preparing") {
    phase = "analyzing";
    actions = ["handoff"];
  } else if (facts.latestReply && facts.replyStaleReason) {
    phase = "draft_stale";
    reason = facts.replyStaleReason;
    actions = ["prepare", "handoff"];
  } else if (["failed", "cancelled"].includes(delivery?.state) || facts.failedAnalysis || facts.status === "failed") {
    phase = "send_failed";
    reason = delivery?.outcomeCode || (delivery?.state === "cancelled" ? "DELIVERY_CANCELLED" : delivery?.state === "failed" ? "DELIVERY_FAILED" : "PREPARATION_FAILED");
    actions = delivery?.state === "failed" ? ["retry_failed_delivery", "handoff"] : delivery?.state === "cancelled" ? ["retry_cancelled_delivery", "handoff"] : ["prepare", "handoff"];
  } else if (facts.sourceMode === "observe" && facts.status === "completed") {
    phase = "observing";
    reason = "OBSERVE_MODE";
    actions = [];
  } else if (facts.latestReply) {
    phase = "review_required";
    reason = "POLICY_REVIEW_REQUIRED";
    actions = ["approve", "handoff"];
  } else {
    phase = "observed";
    actions = ["prepare", "handoff"];
  }

  const [tone, label] = presentation[phase];
  return {
    phase,
    tone,
    label,
    reason,
    actions,
    successorId: facts.successorId ?? null,
    automation: {
      configured: facts.sourceMode === "automatic",
      outcome: facts.authorizationActorKind === "policy" ? "authorized" : facts.authorizationActorKind === "human" ? "human" : "review",
    },
  };
}
