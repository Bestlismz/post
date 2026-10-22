import { z } from "zod";
import { rentalUnitFactSchema } from "../inventory/facts.mjs";

export function immutable(value) {
  if (value && typeof value === "object") { for (const child of Object.values(value)) immutable(child); Object.freeze(value); }
  return value;
}

export function safeText(value) {
  if (typeof value !== "string" || !value.isWellFormed() || /[\p{Cc}\p{Cf}]/u.test(value)) throw new Error("Unsafe Unicode text");
  return value;
}

function contactSafe(value) {
  safeText(value);
  const digits = value.normalize("NFKC").replace(/[๐-๙]/gu, digit => String(digit.charCodeAt(0) - 0x0e50));
  if (/(?:https?:\/\/|www\.|[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:\+?\d[\s()-]*){9,}|\bline\s*(?:id|[:：@])|\b(?:line\.me|lin\.ee)\b)/iu.test(digits)) throw new Error("Inventory contact data is forbidden");
}

export function readSnapshot(snapshot) {
  z.string().min(1).parse(snapshot?.id);
  const facts = z.array(rentalUnitFactSchema).parse(snapshot?.factSnapshot);
  const seen = new Set();
  for (const fact of facts) {
    if (seen.has(fact.unitId)) throw new Error("Duplicate snapshot unit");
    seen.add(fact.unitId);
    if (!validDate(fact.availableFrom)) throw new Error("Invalid calendar date");
    if (fact.bedrooms !== null && (!Number.isInteger(fact.bedrooms) || fact.bedrooms < 0)) throw new Error("Invalid bedrooms");
    for (const text of [fact.unitCode, fact.projectName, ...fact.transit.map(item => item.station)]) contactSafe(text);
    if (!fact.unitCode.trim() || !fact.projectName.trim()) throw new Error("Missing unit identity");
  }
  return immutable({ id: snapshot.id, factSnapshot: facts });
}

export function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export const formatSchema = z.strictObject({
  locale: z.enum(["th", "en"]), tone: z.enum(["neutral", "friendly", "formal"]),
  greetingId: z.enum(["hello", "none"]), closingId: z.enum(["thanks", "none"]), ctaId: z.enum(["requirements", "follow_up", "none"]),
  emojiPolicy: z.enum(["none", "friendly"]), maxLength: z.number().int().min(80).max(2000),
  numberFormat: z.enum(["grouped", "plain"]), dateFormat: z.enum(["iso", "dmy"]),
  requiredDisclosureId: z.enum(["snapshot", "confirm"]), forbiddenPhrases: z.array(z.string().min(1)).max(20),
});
export function readFormat(format) {
  const value = formatSchema.parse(format);
  value.forbiddenPhrases.forEach(safeText);
  if (value.tone === "formal" && value.emojiPolicy !== "none") throw new Error("Formal tone is incompatible with emoji");
  return immutable(value);
}

export const selectionSchema = z.strictObject({
  units: z.array(z.strictObject({ unitId: z.string().min(1), factIds: z.array(z.enum(["identity", "price", "availableFrom", "bedrooms", "petPolicy", "transit"])).min(1).max(6) })).max(10),
  templateId: z.enum(["options", "clarify", "handoff"]),
});

export function readSelections(input, snapshot) {
  const selections = selectionSchema.parse(input);
  if ((selections.templateId === "options") !== (selections.units.length > 0)) throw new Error("Incompatible selection template");
  const seen = new Set();
  for (const selected of selections.units) {
    const fact = snapshot.factSnapshot.find(item => item.unitId === selected.unitId);
    if (!fact || seen.has(selected.unitId)) throw new Error("Unsupported or duplicate unit ID");
    seen.add(selected.unitId);
    if (new Set(selected.factIds).size !== selected.factIds.length || !selected.factIds.includes("identity")) throw new Error("Selections require unique facts and unit identity");
    if (selected.factIds.includes("bedrooms") && fact.bedrooms === null) throw new Error("Unknown bedroom fact");
    if (selected.factIds.includes("transit") && !fact.transit.length) throw new Error("Missing transit fact");
  }
  return immutable(selections);
}

export async function structuredResponse({ client, model = "gpt-5-mini", name, schema, instructions, input }) {
  if (!client?.responses?.create) throw new Error("OpenAI client required");
  const response = await client.responses.create({ model, instructions, input: JSON.stringify(input), text: { format: { type: "json_schema", name, strict: true, schema: z.toJSONSchema(schema) } } });
  if (response.status !== "completed") throw new Error("Incomplete OpenAI response");
  return schema.parse(JSON.parse(response.output_text));
}
