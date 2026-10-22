import { z } from "zod";

const text = z.string().transform((value) => value.normalize("NFC").trim().replace(/\s+/gu, " ")).pipe(z.string().min(1));
const id = z.string().min(1);
const optionalText = text.nullable().optional();
const media = z.array(z.url()).optional();
const nonnegative = z.number().finite().nonnegative();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}, "Invalid calendar date");
const description = text.refine((value) => {
  const contactText = value.replace(/[๐-๙]/gu, (digit) => String(digit.charCodeAt(0) - 0x0e50));
  const contact = /(?:https?:\/\/|www\.|[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:\+?\d[\s()-]*){9,})/iu;
  const lineLink = /(?:^|[^\p{L}\p{N}_.-])(?:line\.me|lin\.ee)(?:[/?#]|$|\s)/iu;
  const lineId = /\bline\s+id\b\s*[:：=]?\s*@?[a-z0-9_.-]+/iu;
  return !contact.test(contactText) && !lineLink.test(contactText) && !lineId.test(contactText);
}, "description must be contact-safe");

export const projectFields = {
  name: text,
  address: optionalText,
  district: optionalText,
  province: optionalText,
  latitude: z.number().finite().min(-90).max(90).nullable().optional(),
  longitude: z.number().finite().min(-180).max(180).nullable().optional(),
  transit: z.array(z.strictObject({ station: text, walkingDistanceM: nonnegative.int() })).optional(),
  amenities: z.array(text).optional(),
  media,
};
export const unitFields = {
  projectId: id,
  unitCode: text,
  roomType: optionalText,
  bedrooms: nonnegative.int().nullable().optional(),
  bathrooms: nonnegative.int().nullable().optional(),
  floor: z.number().int().nullable().optional(),
  areaSqm: z.number().finite().positive().nullable().optional(),
  monthlyRentThb: z.number().finite().positive().nullable().optional(),
  depositMonths: nonnegative.nullable().optional(),
  advanceMonths: nonnegative.nullable().optional(),
  petPolicy: z.enum(["allowed", "case_by_case", "not_allowed", "unknown"]).nullable().optional(),
  availableFrom: date.nullable().optional(),
  description: description.nullable().optional(),
  media,
};

const createProject = z.strictObject(projectFields);
const createUnit = z.strictObject(unitFields);
const updateProject = createProject.partial().extend({ id });
const updateUnit = createUnit.partial().extend({ id });
const identity = z.strictObject({ id });
const availability = identity.extend({ status: z.enum(["draft", "unknown", "available", "held", "rented"]) });
const schemas = { createProject, updateProject, createUnit, updateUnit, publishUnit: identity, archiveUnit: identity, changeAvailability: availability };
const context = z.object({ organizationId: id, actorId: id, idempotencyKey: z.string().trim().min(1) });

export function validateCommand(action, command) {
  context.parse(command);
  if (!action.startsWith("create")) z.object({ expectedRevision: z.number().int().positive() }).parse(command);
  return schemas[action].parse(command.input);
}

export function validatePublication(unit) {
  const required = ["projectId", "monthlyRentThb", "roomType", "availableFrom", "description", "petPolicy"];
  const missing = required.filter((key) => unit[key] == null || unit[key] === "");
  if (missing.length) {
    const error = new Error(`Publication requires ${missing.join(", ")}`);
    error.status = 422;
    error.fields = missing;
    throw error;
  }
  z.object({ description }).parse(unit);
}
