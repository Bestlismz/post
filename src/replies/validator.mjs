import { isDeepStrictEqual } from "node:util";
import { safeText } from "./contracts.mjs";
import { renderReply } from "./renderer.mjs";

/** Context must come from the immutable stored snapshot, selections and format, never from edited reply metadata. */
export function validateReply(reply, { snapshot, selections, format }) {
  if (reply?.grounded === false && reply.editKind === "human_free_edit" && reply.automaticEligible === false) {
    safeText(reply.text.replaceAll("\n", " "));
    if (!reply.text.trim() || [...reply.text].length > format.maxLength) throw new Error("Invalid human edit");
    return { grounded: false, automaticEligible: false, reason: "human_free_edit" };
  }
  const expected = renderReply(selections, snapshot, format);
  if (!isDeepStrictEqual(reply, expected)) throw new Error("Unsupported fact or render provenance");
  return { grounded: true, automaticEligible: true };
}
