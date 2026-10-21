const allowedVariables = new Set(["customer_name", "location", "budget", "move_date", "business_name"]);

export function validateReplyProfile(input) {
  const profile = {
    language: ["th", "en", "bilingual"].includes(input?.language) ? input.language : "th",
    tone: String(input?.tone || "friendly").slice(0, 40),
    greeting: String(input?.greeting || "").trim(), closing: String(input?.closing || "").trim(),
    maxLength: Math.max(80, Math.min(2000, Number(input?.maxLength) || 500)),
    requiredPhrases: cleanList(input?.requiredPhrases), forbiddenPhrases: cleanList(input?.forbiddenPhrases),
    humanHandoffKeywords: cleanList(input?.humanHandoffKeywords),
    answerUnknownWith: "acknowledge_and_handoff",
  };
  for (const value of [profile.greeting, profile.closing]) for (const match of value.matchAll(/\{([^}]+)\}/g)) if (!allowedVariables.has(match[1])) throw new Error(`Unknown reply variable: ${match[1]}`);
  return profile;
}

export function renderReplyProfile(profile, fields, body) {
  const replace = (value) => value.replace(/\{([^}]+)\}/g, (_, key) => String(fields?.[key] ?? "")).replace(/\s{2,}/g, " ").trim();
  return [replace(profile.greeting), String(body || "").trim(), replace(profile.closing)].filter(Boolean).join("\n").slice(0, profile.maxLength);
}

export function decideReplyAction({ event, thread = {}, analysis = {}, config = {}, now = Date.now() }) {
  const text = event?.text?.toLowerCase() ?? "";
  if (thread.status === "human_handoff" || thread.status === "paused" || !config.enabled) return { action: "ignore", reason: "automation_disabled" };
  if ((config.handoffKeywords ?? []).some((word) => text.includes(word.toLowerCase()))) return { action: "acknowledge_and_handoff", reason: "human_requested" };
  if (/(หยุด|ไม่ต้องตอบ|stop|unsubscribe)/i.test(text)) return { action: "ignore", reason: "opt_out" };
  if (event.attachments?.length && !event.text) return { action: "acknowledge_and_handoff", reason: "attachment_only" };
  if (now - Number(event.timestamp) > 24 * 60 * 60 * 1000) return { action: "ignore", reason: "outside_window" };
  if ((analysis.score ?? 0) < (config.minimumAutoReplyConfidence ?? 75)) return { action: "clarify", reason: "low_confidence" };
  return { action: "reply", reason: "eligible" };
}

export function validateGeneratedReply(text, profile) {
  const value = String(text || "").trim();
  if (!value) throw new Error("Reply is empty");
  for (const phrase of profile.requiredPhrases ?? []) if (!value.toLowerCase().includes(phrase.toLowerCase())) throw new Error("Reply is missing a required phrase");
  for (const phrase of profile.forbiddenPhrases ?? []) if (value.toLowerCase().includes(phrase.toLowerCase())) throw new Error("Reply contains a forbidden phrase");
  if (/(ยืนยันว่ามีห้อง|จองให้แล้ว|รับประกันราคา|guaranteed available|booking confirmed)/i.test(value)) throw new Error("Reply makes an unsupported promise");
  return value.slice(0, profile.maxLength);
}

function cleanList(value) { return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean).slice(0, 20) : []; }
