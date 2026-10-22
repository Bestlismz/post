import { z } from "zod";

const nullableText = z.string().nullable();
const nullableNumber = z.number().finite().nullable();
export const rentalUnitFactSchema = z.strictObject({
  kind: z.literal("rental_unit"), unitId: z.string().min(1), unitRevision: z.number().int().positive(),
  projectId: z.string().min(1), projectRevision: z.number().int().positive(),
  unitCode: z.string(), projectName: z.string(), address: nullableText, district: nullableText, province: nullableText,
  roomType: z.string(), bedrooms: nullableNumber, bathrooms: nullableNumber, floor: nullableNumber, areaSqm: nullableNumber,
  monthlyRentThb: z.number().positive(), depositMonths: nullableNumber, advanceMonths: nullableNumber,
  petPolicy: z.enum(["allowed", "case_by_case", "not_allowed", "unknown"]), availableFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  publishedAt: z.string(), factsUpdatedAt: z.string(),
  transit: z.array(z.strictObject({ station: z.string(), walkingDistanceM: z.number().nonnegative() })), amenities: z.array(z.string()),
});

/** Explicit sourced facts form the discriminated rendering contract for later replies. */
export function snapshotUnitFacts(unit) {
  const project = unit.project;
  return rentalUnitFactSchema.parse({
    kind: "rental_unit", unitId: unit.id, unitRevision: unit.revision, projectId: project.id, projectRevision: project.revision,
    unitCode: unit.unitCode, projectName: project.name, address: project.address ?? null, district: project.district ?? null, province: project.province ?? null,
    roomType: unit.roomType, bedrooms: unit.bedrooms ?? null, bathrooms: unit.bathrooms ?? null, floor: unit.floor ?? null, areaSqm: unit.areaSqm ?? null,
    monthlyRentThb: unit.monthlyRentThb, depositMonths: unit.depositMonths ?? null, advanceMonths: unit.advanceMonths ?? null,
    petPolicy: unit.petPolicy, availableFrom: unit.availableFrom, publishedAt: unit.publishedAt, factsUpdatedAt: unit.factsUpdatedAt,
    transit: project.transit, amenities: project.amenities,
  });
}
