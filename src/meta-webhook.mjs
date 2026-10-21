import crypto from "node:crypto";

export function verifyChallenge(query, expectedToken) {
  if (query?.["hub.mode"] !== "subscribe" || !expectedToken || query?.["hub.verify_token"] !== expectedToken) return null;
  return String(query["hub.challenge"] ?? "");
}

export function verifySignature(rawBody, header, secret) {
  if (!Buffer.isBuffer(rawBody) || !secret || typeof header !== "string" || !header.startsWith("sha256=")) return false;
  const expected = Buffer.from(crypto.createHmac("sha256", secret).update(rawBody).digest("hex"));
  const received = Buffer.from(header.slice(7));
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

export function normalizePageEvents(payload, pageId) {
  if (payload?.object !== "page") return [];
  const events = [];
  for (const entry of payload.entry ?? []) {
    if (String(entry.id) !== String(pageId)) continue;
    for (const item of entry.messaging ?? []) {
      const message = item.message;
      if (!message?.mid || message.is_echo || item.delivery || item.read || String(item.recipient?.id) !== String(pageId)) continue;
      const attachments = Array.isArray(message.attachments) ? message.attachments.map(({ type, payload: value }) => ({ type, url: value?.url ?? null })) : [];
      if (typeof message.text !== "string" && !attachments.length) continue;
      events.push({ key: `${pageId}:${message.mid}`, pageId: String(pageId), mid: message.mid, senderId: String(item.sender?.id ?? ""), timestamp: Number(item.timestamp ?? Date.now()), text: message.text?.trim() ?? "", attachments });
    }
  }
  return events;
}
