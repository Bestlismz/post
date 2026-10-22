import { z } from "zod";

export const automationPauseInput = z.strictObject({ paused: z.boolean() });
export const automationLimits = z.strictObject({
  organization: z.number().int().positive(),
  source: z.number().int().positive(),
  conversation: z.number().int().positive(),
});
const clockTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
export const automationBusinessHours = z.strictObject({
  timeZone: z.string().min(1).max(100),
  days: z.array(z.number().int().min(0).max(6)).min(1),
  start: z.string(),
  end: z.string(),
}).superRefine((value, context) => {
  if (!clockTime.test(value.start) || !(clockTime.test(value.end) || value.end === "24:00") || value.start >= value.end) {
    context.addIssue({ code: "custom", path: ["start"], message: "Invalid business hours" });
  }
  try { new Intl.DateTimeFormat("en-US", { timeZone: value.timeZone }).format(new Date(0)); }
  catch { context.addIssue({ code: "custom", path: ["timeZone"], message: "Invalid time zone" }); }
});
export const automationPolicy = z.strictObject({
  mode: z.enum(["observe", "approval", "automatic"]),
  minimumConfidence: z.number().min(0).max(1),
  rateLimits: automationLimits,
  businessHours: automationBusinessHours,
});
export const sourcePolicy = z.strictObject({
  rateLimits: automationLimits,
  businessHours: automationBusinessHours,
});
export const sourceMode = z.enum(["observe", "approval", "automatic"]);
export const publicSourceUpdatePatch = z.strictObject({
  mode: sourceMode.optional(),
  allowListed: z.boolean().optional(),
  policy: sourcePolicy.optional(),
  killSwitch: z.boolean().optional(),
});
export const internalSourceUpdatePatch = publicSourceUpdatePatch.extend({
  archived: z.literal(true).optional(),
});
export const policyPreviewSample = z.strictObject({
  grounded: z.boolean(),
  automaticEligible: z.boolean(),
  confidence: z.number().min(0).max(1),
  replyWindowOpen: z.boolean(),
  optOut: z.boolean().optional(),
  humanTakeover: z.boolean().optional(),
});
export const policyPreviewInput = z.strictObject({
  sourceId: z.string().min(1).max(200),
  conversationId: z.string().min(1).max(200),
  sample: policyPreviewSample,
});
const maintenanceWindow = z.strictObject({ startsAt: z.iso.datetime(), endsAt: z.iso.datetime() });
export const automationSchedule = z.strictObject({
  enabled: z.boolean(),
  cadenceMinutes: z.number().int().min(1).max(1440),
  timeZone: z.string().min(1).max(100),
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  start: z.string(),
  end: z.string(),
  dailyLimit: z.number().int().min(1).max(1440),
  maintenanceWindows: z.array(maintenanceWindow).max(100),
});
