import { isDeepStrictEqual } from "node:util";
import { renderReply, validateFormatText } from "./renderer.mjs";

/** Context must come from the immutable stored snapshot, selections and format, never from edited reply metadata. */
export function validateReply(reply, { snapshot, selections, format }) {
  if (reply?.grounded === false && reply.editKind === "human_free_edit" && reply.automaticEligible === false) {
    validateFormatText(reply.text, format);
    return { grounded: false, automaticEligible: false, reason: "human_free_edit" };
  }
  const expected = renderReply(selections, snapshot, format);
  if (!isDeepStrictEqual(reply, expected)) throw new Error("Unsupported fact or render provenance");
  return { grounded: true, automaticEligible: true };
}
