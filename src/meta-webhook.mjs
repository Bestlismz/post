import crypto from "node:crypto";

export function verifyChallenge(query, expectedToken) {
  if (query?.["hub.mode"] !== "subscribe" || !expectedToken || query?.["hub.verify_token"] !== expectedToken) return null;
  return typeof query["hub.challenge"] === "string" ? query["hub.challenge"] : null;
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
  for (const entry of Array.isArray(payload.entry) ? payload.entry : []) {
    if (entry?.id !== pageId) continue;
    for (const item of Array.isArray(entry.messaging) ? entry.messaging : []) {
      const message = item?.message;
      if (typeof message?.mid !== "string" || !message.mid || message.is_echo || item.delivery || item.read || item.recipient?.id !== pageId) continue;
      if (typeof item.sender?.id !== "string" || !item.sender.id || item.sender.id === pageId) continue;
      // Only text is supported until an attachment-specific generation path exists.
      if (message.attachments != null && (!Array.isArray(message.attachments) || message.attachments.length)) continue;
      if (typeof message.text !== "string" || !message.text.trim()) continue;
      const timestamp = Number.isSafeInteger(item.timestamp) && item.timestamp >= 0 ? item.timestamp : null;
      events.push({ key: `${pageId}:${message.mid}`, pageId, mid: message.mid, senderId: item.sender.id, timestamp, text: message.text.trim(), attachments: [] });
    }
  }
  return events;
}
