import { randomUUID } from "node:crypto";

const seededProjects = [
  { id: "fixture-life-asoke", organizationId: "org_default", name: "Life Asoke", address: "ถนนอโศก-ดินแดง", district: "ราชเทวี", province: "กรุงเทพมหานคร", latitude: 13.753, longitude: 100.561, transit: [{ station: "MRT เพชรบุรี", walkingDistanceM: 300 }], amenities: ["สระว่ายน้ำ", "ฟิตเนส", "พื้นที่ทำงาน"], media: [], revision: 1 },
  { id: "fixture-ideo-ari", organizationId: "org_default", name: "Ideo Mobi Ari", address: "ถนนพหลโยธิน", district: "พญาไท", province: "กรุงเทพมหานคร", latitude: 13.779, longitude: 100.544, transit: [{ station: "BTS อารีย์", walkingDistanceM: 180 }], amenities: ["สระว่ายน้ำ", "ฟิตเนส"], media: [], revision: 1 },
  { id: "fixture-noble-remix", organizationId: "org_default", name: "Noble Remix", address: "สุขุมวิท 36", district: "คลองเตย", province: "กรุงเทพมหานคร", latitude: 13.724, longitude: 100.579, transit: [{ station: "BTS ทองหล่อ", walkingDistanceM: 120 }], amenities: ["สระว่ายน้ำ", "ฟิตเนส", "ร้านสะดวกซื้อ"], media: [], revision: 1 },
];

const seededUnits = [
  unit("fixture-life-a1207", "fixture-life-asoke", "A-1207", "1 ห้องนอน", 18000, "allowed", "2026-11-01", 12, 35, "available", true),
  unit("fixture-life-b1804", "fixture-life-asoke", "B-1804", "1 ห้องนอน", 19500, "case_by_case", "2026-11-15", 18, 40, "held", true),
  unit("fixture-ari-s903", "fixture-ideo-ari", "S-903", "สตูดิโอ", 17000, "allowed", "2026-11-05", 9, 27, "available", true),
  unit("fixture-remix-c610", "fixture-noble-remix", "C-610", "1 ห้องนอน", 25000, "not_allowed", "2026-12-01", 6, 42, "draft", false),
];

function unit(id, projectId, unitCode, roomType, monthlyRentThb, petPolicy, availableFrom, floor, areaSqm, status, published) {
  return { id, organizationId: "org_default", projectId, unitCode, roomType, bedrooms: roomType === "สตูดิโอ" ? 0 : 1, bathrooms: 1, floor, areaSqm, monthlyRentThb, depositMonths: 2, advanceMonths: 1, petPolicy, availableFrom, description: "เฟอร์นิเจอร์ครบ ใกล้รถไฟฟ้า พร้อมนัดชมห้อง", status, publishedAt: published ? "2026-10-22T08:00:00.000Z" : null, factsUpdatedAt: "2026-10-22T08:00:00.000Z", media: [], revision: 1 };
}

function failure(status, message, fields) {
  const error = new Error(message);
  error.status = status;
  error.fields = fields;
  throw error;
}

export function createInventoryWorkspaceFixture() {
  let projects = structuredClone(seededProjects);
  let units = structuredClone(seededUnits);
  const requireRevision = (entity, expected) => {
    if (!entity) failure(404, "Resource not found");
    if (entity.revision !== expected) failure(409, "Revision conflict");
    if (entity.status === "archived") failure(409, "Unit is archived");
  };
  const saveUnit = (index, next) => {
    const saved = { ...next, revision: next.revision + 1, factsUpdatedAt: new Date().toISOString() };
    units[index] = saved;
    return structuredClone(saved);
  };
  return {
    listProjects: () => ({ projects: structuredClone(projects) }),
    listUnits: () => ({ units: structuredClone(units) }),
    getProject(id) { return structuredClone(projects.find((entry) => entry.id === id) ?? null); },
    getUnit(id) { return structuredClone(units.find((entry) => entry.id === id) ?? null); },
    createProject(input) {
      if (!input.name?.trim()) failure(422, "Invalid request", ["name"]);
      const project = { transit: [], amenities: [], media: [], ...structuredClone(input), id: randomUUID(), organizationId: "org_default", revision: 1 };
      projects.push(project);
      return structuredClone(project);
    },
    updateProject(id, input, expectedRevision) {
      const index = projects.findIndex((entry) => entry.id === id), current = projects[index];
      requireRevision(current, expectedRevision);
      const project = { ...current, ...structuredClone(input), id, revision: current.revision + 1 };
      projects[index] = project;
      return structuredClone(project);
    },
    createUnit(input) {
      if (!projects.some((entry) => entry.id === input.projectId)) failure(404, "Project not found");
      if (!input.unitCode?.trim()) failure(422, "Invalid request", ["unitCode"]);
      const created = { bedrooms: null, bathrooms: null, floor: null, areaSqm: null, monthlyRentThb: null, depositMonths: null, advanceMonths: null, petPolicy: null, availableFrom: null, description: null, media: [], ...structuredClone(input), id: randomUUID(), organizationId: "org_default", status: "draft", publishedAt: null, factsUpdatedAt: new Date().toISOString(), revision: 1 };
      units.push(created);
      return structuredClone(created);
    },
    updateUnit(id, input, expectedRevision) {
      const index = units.findIndex((entry) => entry.id === id), current = units[index];
      requireRevision(current, expectedRevision);
      if (current.publishedAt) validatePublication({ ...current, ...input });
      return saveUnit(index, { ...current, ...structuredClone(input), id });
    },
    changeAvailability(id, status, expectedRevision) {
      const index = units.findIndex((entry) => entry.id === id), current = units[index];
      requireRevision(current, expectedRevision);
      return saveUnit(index, { ...current, status });
    },
    publishUnit(id, expectedRevision) {
      const index = units.findIndex((entry) => entry.id === id), current = units[index];
      requireRevision(current, expectedRevision);
      validatePublication(current);
      if (current.status !== "available") failure(422, "Only available units can publish");
      return saveUnit(index, { ...current, publishedAt: new Date().toISOString() });
    },
    archiveUnit(id, expectedRevision) {
      const index = units.findIndex((entry) => entry.id === id), current = units[index];
      requireRevision(current, expectedRevision);
      return saveUnit(index, { ...current, status: "archived" });
    },
  };
}

function validatePublication(value) {
  const required = ["projectId", "unitCode", "roomType", "monthlyRentThb", "availableFrom", "petPolicy", "description"];
  const missing = required.filter((key) => value[key] == null || value[key] === "");
  if (missing.length) failure(422, "Publication requires complete facts", missing);
}
