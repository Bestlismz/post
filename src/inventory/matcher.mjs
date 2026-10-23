import { z } from "zod";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}, "Invalid calendar date");
const names = z.array(z.string().min(1)).min(1);
export const requirementsSchema = z.strictObject({
  budgetMin: z.number().finite().nonnegative().optional(),
  budgetMax: z.number().finite().positive().optional(),
  bedrooms: z.number().int().nonnegative().optional(),
  moveInDate: date.optional(),
  requiredPetPolicy: z.enum(["allowed", "case_by_case", "not_allowed"]).optional(),
  roomType: z.enum(["studio", "1_bedroom", "2_bedroom", "3_bedroom"]).optional(),
  geography: z.strictObject({ projectIds: names.optional(), districts: names.optional(), provinces: names.optional(), stations: names.optional() }).optional(),
}).refine(value => value.budgetMin == null || value.budgetMax == null || value.budgetMin <= value.budgetMax, "Invalid budget range");
export const policySchema = z.strictObject({ minimumScore: z.number().int().min(0).max(100).default(0), limit: z.number().int().positive().max(100).default(20) });
export const MATCHER_VERSION = "inventory-v1";

/** Date-only strings represent Asia/Bangkok calendar dates; no host-local conversion occurs. */
export function matchInventory(requirements, units, policy = {}) {
  const r = requirementsSchema.parse(requirements);
  const p = policySchema.parse(policy);
  const candidates = [];
  for (const unit of units) {
    if (!unit.publishedAt || unit.status !== "available" || !unit.project || unit.projectId !== unit.project.id) continue;
    if (!date.safeParse(unit.availableFrom).success || !Number.isFinite(unit.monthlyRentThb) || unit.monthlyRentThb <= 0) continue;
    const explanations = ["published_available"];
    let score = 0;
    if (r.moveInDate !== undefined) {
      if (unit.availableFrom > r.moveInDate) continue;
      explanations.push("available_by_move_in"); score += 20;
    }
    if (r.budgetMin !== undefined || r.budgetMax !== undefined) {
      if (unit.monthlyRentThb < (r.budgetMin ?? 0) || unit.monthlyRentThb > (r.budgetMax ?? Infinity)) continue;
      explanations.push("within_budget"); score += 20;
    }
    if (r.bedrooms !== undefined) {
      if (unit.bedrooms !== r.bedrooms) continue;
      explanations.push("bedrooms_match"); score += 20;
    }
    if (r.roomType !== undefined) {
      const normalized = String(unit.roomType ?? "").toLocaleLowerCase("en-US").replace(/[\s_-]+/gu, "_").replace(/^([123])_bedrooms$/u, "$1_bedroom");
      if (normalized !== r.roomType) continue;
      explanations.push("room_type_match"); score += 20;
    }
    if (r.geography && Object.keys(r.geography).length) {
      const g = r.geography, project = unit.project;
      if (g.projectIds && !g.projectIds.includes(project.id)) continue;
      if (g.districts && !g.districts.includes(project.district)) continue;
      if (g.provinces && !g.provinces.includes(project.province)) continue;
      if (g.stations && !project.transit?.some(entry => g.stations.includes(entry.station))) continue;
      explanations.push("geography_match"); score += 20;
    }
    if (r.requiredPetPolicy !== undefined) {
      if (unit.petPolicy !== r.requiredPetPolicy) continue;
      explanations.push("pet_policy_match"); score += 20;
    }
    if (score >= p.minimumScore) candidates.push({ unitId: unit.id, unitRevision: unit.revision, projectId: unit.projectId, projectRevision: unit.project.revision, score, explanations });
  }
  candidates.sort((a, b) => b.score - a.score || (a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0));
  return { matcherVersion: MATCHER_VERSION, candidates: candidates.slice(0, p.limit) };
}
