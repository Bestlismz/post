import { httpError } from "../auth/authorize.mjs";

export function validateInboxText(value, label, { maxLength = 200, allowEmpty = false } = {}) {
  if (typeof value !== "string" || value.length > maxLength
    || (!allowEmpty && !value.trim()) || /[\p{Cc}\p{Cs}]/u.test(value)) {
    throw httpError(400, `Invalid ${label}`);
  }
  return value;
}
