import OpenAI from "openai";
import { analyzeDeterministically } from "./relevance.mjs";
import { extractRequirements } from "./replies/extractor.mjs";
import { composeSelections } from "./replies/composer.mjs";
import { defaultReplyFormat, renderReply } from "./replies/renderer.mjs";
import { validateReply } from "./replies/validator.mjs";

export function createMessengerGenerator({ apiKey, model = "gpt-5-mini", client } = {}) {
  const openai = client ?? (apiKey ? new OpenAI({ apiKey }) : null);
  return async function generate(event, thread, business, profile) {
    const format = thread.replyFormat ?? { ...defaultReplyFormat(profile.language === "en" ? "en" : "th"), maxLength: profile.maxLength ?? 1800, forbiddenPhrases: profile.forbiddenPhrases ?? [] };
    const snapshot = thread.matchSnapshot ?? { id: "no_inventory", factSnapshot: [] };
    const fallback = () => {
      const result = analyzeDeterministically({ key: event.key, text: event.text, context: [], fingerprint: event.key }, business);
      const reply = Object.freeze({ ...renderReply({ units: [], templateId: "clarify" }, { id: "no_inventory", factSnapshot: [] }, format), automaticEligible: false });
      return { text: reply.text, reply, automaticEligible: false, analysis: { score: result.score, intent: result.intent, extracted: result.extracted, missing: ["human_review"] }, source: "deterministic_fallback" };
    };
    if (!openai) return fallback();
    try {
      const conversation = thread.conversation ?? { id: thread.id ?? String(event.key), revision: thread.processingRevision ?? 1, messages: [{ id: String(event.key), revision: 1, text: event.text }] };
      const extraction = await extractRequirements({ conversation, businessProfile: business, client: openai, model });
      const selections = await composeSelections({ snapshot, format, extraction, client: openai, model });
      const reply = renderReply(selections, snapshot, format);
      validateReply(reply, { snapshot, selections, format });
      return { text: reply.text, reply, extraction, automaticEligible: true, analysis: { score: 0, intent: "tenant_lead", extracted: extraction.requirements, missing: Object.entries(extraction.fields).filter(([, entry]) => entry.status !== "known").map(([field]) => field) }, source: "openai_grounded" };
    } catch { return fallback(); }
  };
}
