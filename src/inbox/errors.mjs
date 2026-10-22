import { httpError } from '../auth/authorize.mjs';

export function inboxConflict(code, message) {
  return Object.assign(httpError(409, message), { code });
}

export const freshnessConflictCodes = new Set([
  'POLICY_CHANGED', 'PROFILE_CHANGED', 'FORMAT_CHANGED', 'SOURCE_CHANGED', 'INVENTORY_CHANGED',
]);

export const terminalPreparationCodes = new Set([
  'CONVERSATION_SUPERSEDED', 'HUMAN_TAKEOVER', 'TRIGGER_AUTHORIZED', 'WORK_ITEM_NOT_FOUND',
]);
