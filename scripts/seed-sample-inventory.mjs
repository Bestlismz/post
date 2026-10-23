import { pathToFileURL } from "node:url";
import { createPool } from "../src/db/pool.mjs";
import { createCatalog } from "../src/inventory/catalog.mjs";

export const sampleInventory = [
  { project: { name: "Life Asoke", district: "อโศก", province: "กรุงเทพมหานคร", address: "ถนนอโศก-ดินแดง", transit: [{ station: "MRT พระราม 9", walkingDistanceM: 350 }], amenities: ["สระว่ายน้ำ", "ฟิตเนส", "Co-working space"] }, units: [
    { unitCode: "LA-1207", roomType: "1 bedroom", bedrooms: 1, bathrooms: 1, floor: 12, areaSqm: 35, monthlyRentThb: 18000, petPolicy: "case_by_case", availableFrom: "2026-10-25", description: "ห้องมุมแต่งครบ วิวเมือง เดินทางสะดวก" },
    { unitCode: "LA-1812", roomType: "2 bedroom", bedrooms: 2, bathrooms: 2, floor: 18, areaSqm: 54, monthlyRentThb: 29000, petPolicy: "not_allowed", availableFrom: "2026-11-01", description: "ห้องสองห้องนอน แยกครัวเป็นสัดส่วน เหมาะสำหรับอยู่สองคน" },
  ] },
  { project: { name: "Ideo Mobi Sukhumvit", district: "อ่อนนุช", province: "กรุงเทพมหานคร", address: "ถนนสุขุมวิท", transit: [{ station: "BTS อ่อนนุช", walkingDistanceM: 180 }], amenities: ["สระว่ายน้ำ", "ฟิตเนส", "สวนส่วนกลาง"] }, units: [
    { unitCode: "IM-0804", roomType: "studio", bedrooms: 0, bathrooms: 1, floor: 8, areaSqm: 24, monthlyRentThb: 13000, petPolicy: "not_allowed", availableFrom: "2026-10-28", description: "สตูดิโอเฟอร์นิเจอร์ครบ ใกล้รถไฟฟ้าและร้านสะดวกซื้อ" },
    { unitCode: "IM-1510", roomType: "1 bedroom", bedrooms: 1, bathrooms: 1, floor: 15, areaSqm: 31, monthlyRentThb: 16500, petPolicy: "case_by_case", availableFrom: "2026-11-05", description: "หนึ่งห้องนอน ชั้นสูง แสงดี มีเครื่องซักผ้า" },
  ] },
  { project: { name: "Noble Around Ari", district: "อารีย์", province: "กรุงเทพมหานคร", address: "ซอยอารีย์", transit: [{ station: "BTS อารีย์", walkingDistanceM: 420 }], amenities: ["สระว่ายน้ำ", "ฟิตเนส", "Lounge"] }, units: [
    { unitCode: "NA-0603", roomType: "1 bedroom", bedrooms: 1, bathrooms: 1, floor: 6, areaSqm: 34, monthlyRentThb: 22000, petPolicy: "allowed", availableFrom: "2026-10-30", description: "ห้องเงียบ เหมาะทำงานที่บ้าน และเลี้ยงสัตว์ได้" },
    { unitCode: "NA-1408", roomType: "2 bedroom", bedrooms: 2, bathrooms: 2, floor: 14, areaSqm: 58, monthlyRentThb: 36000, petPolicy: "allowed", availableFrom: "2026-11-10", description: "สองห้องนอน วิวโล่ง มีพื้นที่ทำงานและระเบียง" },
  ] },
  { project: { name: "The Address Sukhumvit 28", district: "พร้อมพงษ์", province: "กรุงเทพมหานคร", address: "สุขุมวิท 28", transit: [{ station: "BTS พร้อมพงษ์", walkingDistanceM: 500 }], amenities: ["สระว่ายน้ำ", "ฟิตเนส", "Sauna"] }, units: [
    { unitCode: "AS-0902", roomType: "1 bedroom", bedrooms: 1, bathrooms: 1, floor: 9, areaSqm: 38, monthlyRentThb: 26000, petPolicy: "not_allowed", availableFrom: "2026-11-01", description: "ห้องหนึ่งห้องนอน ครัวปิด ใกล้ศูนย์การค้า" },
    { unitCode: "AS-1701", roomType: "2 bedroom", bedrooms: 2, bathrooms: 2, floor: 17, areaSqm: 62, monthlyRentThb: 42000, petPolicy: "case_by_case", availableFrom: "2026-11-15", description: "ห้องขนาดใหญ่ เฟอร์นิเจอร์ครบ เหมาะสำหรับครอบครัว" },
  ] },
  { project: { name: "Rhythm Ratchada", district: "พระราม 9", province: "กรุงเทพมหานคร", address: "ถนนรัชดาภิเษก", transit: [{ station: "MRT พระราม 9", walkingDistanceM: 280 }], amenities: ["สระว่ายน้ำ", "ฟิตเนส", "ห้องอ่านหนังสือ"] }, units: [
    { unitCode: "RR-1105", roomType: "studio", bedrooms: 0, bathrooms: 1, floor: 11, areaSqm: 27, monthlyRentThb: 14500, petPolicy: "not_allowed", availableFrom: "2026-10-27", description: "สตูดิโอพร้อมอยู่ ใกล้ MRT และแหล่งช้อปปิ้ง" },
    { unitCode: "RR-2209", roomType: "1 bedroom", bedrooms: 1, bathrooms: 1, floor: 22, areaSqm: 36, monthlyRentThb: 19500, petPolicy: "allowed", availableFrom: "2026-11-03", description: "ชั้นสูง วิวเมือง เลี้ยงสัตว์ได้ตามเงื่อนไขอาคาร" },
  ] },
];

export async function seedSampleInventory({ pool, organizationId = "org_default" }) {
  const { rows: [actor] } = await pool.query("SELECT user_id AS id FROM memberships WHERE organization_id=$1 AND role='admin' ORDER BY created_at,user_id LIMIT 1", [organizationId]);
  if (!actor) throw new Error("An organization admin is required to seed inventory");
  const catalog = createCatalog(pool), command = (key, input, expectedRevision) => ({ organizationId, actorId: actor.id, idempotencyKey: `sample-inventory-v1:${key}`, input, ...(expectedRevision ? { expectedRevision } : {}) });
  const saved = [];
  for (const [projectIndex, entry] of sampleInventory.entries()) {
    const project = await catalog.createProject(command(`project:${projectIndex}`, entry.project));
    for (const [unitIndex, input] of entry.units.entries()) {
      let unit = await catalog.createUnit(command(`unit:${projectIndex}:${unitIndex}`, { ...input, projectId: project.id, depositMonths: 2, advanceMonths: 1 }));
      unit = await catalog.changeAvailability(command(`available:${projectIndex}:${unitIndex}`, { id: unit.id, status: "available" }, unit.revision));
      unit = await catalog.publishUnit(command(`publish:${projectIndex}:${unitIndex}`, { id: unit.id }, unit.revision));
      saved.push({ project, unit });
    }
  }
  return saved;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = createPool({ databaseUrl: process.env.DATABASE_URL });
  try {
    const saved = await seedSampleInventory({ pool });
    process.stdout.write(`Sample inventory ready: ${saved.length} published rooms.\n`);
  } finally { await pool.end(); }
}
