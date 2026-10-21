export function createMetaClient({ pageAccessToken, graphVersion = "v24.0", fetchImpl = fetch, baseUrl = "https://graph.facebook.com" } = {}) {
  return { async sendText({ recipientId, text, metadata }) {
    try {
      const response = await fetchImpl(`${baseUrl}/${graphVersion}/me/messages`, { method: "POST", headers: { Authorization: `Bearer ${pageAccessToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ recipient: { id: recipientId }, messaging_type: "RESPONSE", message: { text, metadata } }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) return { state: "rejected", detail: String(body?.error?.message || `Meta rejected the request (${response.status})`).replace(pageAccessToken || "__none__", "[redacted]").slice(0, 180) };
      return { state: "sent", messageId: body.message_id ?? null, recipientId: body.recipient_id ?? recipientId };
    } catch (error) {
      return { state: "unknown", detail: (error instanceof Error ? error.message : "Network result unknown").replace(pageAccessToken || "__none__", "[redacted]").slice(0, 180) };
    }
  } };
}
