const safeErrors = new Map([
  [0, ["network_error", "เชื่อมต่อระบบไม่ได้ กรุณาลองอีกครั้ง"]],
  [400, ["bad_request", "ข้อมูลไม่ถูกต้อง กรุณาตรวจสอบแล้วลองอีกครั้ง"]],
  [401, ["unauthorized", "เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่"]],
  [403, ["forbidden", "คุณไม่มีสิทธิ์ดำเนินการนี้"]],
  [404, ["not_found", "ไม่พบข้อมูลที่ต้องการ"]],
  [409, ["conflict", "ข้อมูลมีการเปลี่ยนแปลง กรุณาโหลดใหม่"]],
  [422, ["invalid_input", "ข้อมูลบางรายการยังไม่ครบถ้วน"]],
  [429, ["rate_limited", "มีคำขอมากเกินไป กรุณารอสักครู่"]],
]);

const safeReasonCodes = new Set([
  "GLOBAL_PAUSED",
  "SOURCE_PAUSED",
  "SESSION_CIRCUIT_OPEN",
  "SELECTOR_CIRCUIT_OPEN",
]);
const safeErrorCodes = new Set([
  "CONVERSATION_SUPERSEDED", "HUMAN_TAKEOVER", "INVENTORY_CHANGED", "POLICY_CHANGED",
  "PROFILE_CHANGED", "FORMAT_CHANGED", "SOURCE_CHANGED", "FACEBOOK_RESULT_UNKNOWN",
  "PREPARATION_FAILED", "DELIVERY_CANCELLED", "DELIVERY_FAILED", "RETRY_NOT_UNKNOWN",
  "RETRY_NOT_FAILED", "RETRY_NOT_CANCELLED", "RETRY_UNSUPPORTED", "TRIGGER_AUTHORIZED", "INVALID_REPLY_STATE",
]);

export class ApiError extends Error {
  constructor({ status = 0, code = "network_error", message, retryable = false, reasonCode = null } = {}) {
    super(message ?? "เชื่อมต่อระบบไม่ได้ กรุณาลองอีกครั้ง");
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.reasonCode = safeReasonCodes.has(reasonCode) ? reasonCode : null;
  }

  toJSON() {
    return { name: this.name, status: this.status, code: this.code, message: this.message, retryable: this.retryable, reasonCode: this.reasonCode };
  }
}

function mappedError(status, payload) {
  const [fallbackCode, message] = safeErrors.get(status) ?? ["server_error", "ระบบขัดข้องชั่วคราว กรุณาลองอีกครั้ง"];
  const code = safeErrorCodes.has(payload?.code) ? payload.code : fallbackCode;
  return new ApiError({ status, code, message, retryable: status === 0 || status === 429 || status >= 500, reasonCode: payload?.reasonCode });
}

async function decode(response) {
  if (response.status === 204) return null;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response.text();
  try {
    return await response.json();
  } catch {
    throw mappedError(response.status || 500);
  }
}

export const authExpiredEvent = "rendar:auth-expired";

export function createApiClient(fetcher = globalThis.fetch, { onUnauthorized = () => {} } = {}) {
  if (typeof fetcher !== "function") throw new TypeError("fetch is unavailable");
  return {
    async request(resource, options = {}) {
      if (typeof resource !== "string" || (!resource.startsWith("/api/") && resource !== "/health")) {
        throw new TypeError("API resources must be same-origin /api/* or /health paths");
      }
      const headers = new Headers(options.headers);
      if (options.body && !(options.body instanceof FormData) && !headers.has("content-type")) headers.set("content-type", "application/json");
      let response;
      try {
        const method=(options.method??"GET").toUpperCase(),cache=method==="GET"?"no-store":options.cache;
        response = await fetcher(resource, { ...options, cache, credentials: "same-origin", headers });
      } catch {
        throw mappedError(0);
      }
      if (!response.ok) {
        if (response.status === 401 && resource !== "/api/auth/login") {
          try { onUnauthorized(); } catch { /* preserve the safe API error */ }
        }
        let payload = null;
        try { payload = await decode(response); } catch { /* use the safe status mapping */ }
        throw mappedError(response.status, payload);
      }
      return decode(response);
    },
  };
}

export const api = createApiClient(globalThis.fetch, { onUnauthorized: () => globalThis.window?.dispatchEvent(new globalThis.Event(authExpiredEvent)) });
