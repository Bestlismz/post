const projectColumns = { name: "name", address: "address", district: "district", province: "province", latitude: "latitude", longitude: "longitude", media: "media", revision: "revision" };
const unitColumns = { projectId: "project_id", unitCode: "unit_code", roomType: "room_type", bedrooms: "bedrooms", bathrooms: "bathrooms", floor: "floor", areaSqm: "area_sqm", monthlyRentThb: "monthly_rent_thb", depositMonths: "deposit_months", advanceMonths: "advance_months", petPolicy: "pet_policy", availableFrom: "available_from", description: "description", status: "status", publishedAt: "published_at", factsUpdatedAt: "facts_updated_at", media: "media", revision: "revision" };

function decode(row, columns) {
  if (!row) return null;
  const entity = { id: row.id, organizationId: row.organization_id };
  for (const [key, column] of Object.entries(columns)) {
    const value = row[column];
    entity[key] = value instanceof Date ? value.toISOString() : value;
  }
  if (entity.availableFrom) entity.availableFrom = entity.availableFrom.slice(0, 10);
  return entity;
}

export async function getProject(tx, organizationId, id, lock = false) {
  const { rows: [row] } = await tx.query(`SELECT * FROM projects WHERE organization_id=$1 AND id=$2${lock ? " FOR UPDATE" : " FOR SHARE"}`, [organizationId, id]);
  if (!row) return null;
  const project = decode(row, projectColumns);
  const scope = [organizationId, id, project.revision];
  const transit = await tx.query("SELECT station, walking_distance_m FROM project_transit WHERE organization_id=$1 AND project_id=$2 AND project_revision=$3 ORDER BY position", scope);
  const amenities = await tx.query("SELECT name FROM project_amenities WHERE organization_id=$1 AND project_id=$2 AND project_revision=$3 ORDER BY position", scope);
  project.transit = transit.rows.map((r) => ({ station: r.station, walkingDistanceM: r.walking_distance_m }));
  project.amenities = amenities.rows.map((r) => r.name);
  return project;
}

export async function getUnit(tx, organizationId, id) {
  const { rows: [row] } = await tx.query("SELECT units.*, to_char(available_from, 'YYYY-MM-DD') AS available_from FROM units WHERE organization_id=$1 AND id=$2 FOR UPDATE", [organizationId, id]);
  return decode(row, unitColumns);
}

async function save(tx, table, columns, entity, create) {
  const entries = Object.entries(columns);
  const values = [entity.organizationId, entity.id, ...entries.map(([key]) => key === "media" ? JSON.stringify(entity[key] ?? []) : entity[key] ?? null)];
  if (create) {
    await tx.query(`INSERT INTO ${table} (organization_id,id,${entries.map(([, column]) => column).join(",")}) VALUES (${values.map((_, i) => `$${i + 1}`).join(",")})`, values);
  } else {
    await tx.query(`UPDATE ${table} SET ${entries.map(([, column], i) => `${column}=$${i + 3}`).join(",")}${table === "projects" ? ", updated_at=now()" : ""} WHERE organization_id=$1 AND id=$2`, values);
  }
}

export async function saveProject(tx, project, create) {
  await save(tx, "projects", projectColumns, project, create);
  for (const [position, entry] of project.transit.entries()) await tx.query("INSERT INTO project_transit (organization_id,project_id,project_revision,position,station,walking_distance_m) VALUES ($1,$2,$3,$4,$5,$6)", [project.organizationId, project.id, project.revision, position, entry.station, entry.walkingDistanceM]);
  for (const [position, name] of project.amenities.entries()) await tx.query("INSERT INTO project_amenities (organization_id,project_id,project_revision,position,name) VALUES ($1,$2,$3,$4,$5)", [project.organizationId, project.id, project.revision, position, name]);
  return getProject(tx, project.organizationId, project.id);
}

export async function saveUnit(tx, unit, project, create) {
  await save(tx, "units", unitColumns, unit, create);
  const saved = await getUnit(tx, unit.organizationId, unit.id);
  await tx.query("INSERT INTO unit_fact_revisions (organization_id,unit_id,revision,facts) VALUES ($1,$2,$3,$4::jsonb)", [unit.organizationId, unit.id, unit.revision, JSON.stringify({ ...saved, project })]);
  return saved;
}

export async function saveSnapshot(tx, snapshot) {
  await tx.query(`INSERT INTO match_snapshots
    (organization_id,id,requirements_revision,requirements,policy,matcher_version,inventory_watermark,candidates,fact_snapshot)
    VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7::jsonb,$8::jsonb,$9::jsonb)`, [
    snapshot.organizationId, snapshot.id, snapshot.requirementsRevision, JSON.stringify(snapshot.requirements),
    JSON.stringify(snapshot.policy), snapshot.matcherVersion, JSON.stringify(snapshot.inventoryWatermark),
    JSON.stringify(snapshot.candidates), JSON.stringify(snapshot.factSnapshot),
  ]);
  return snapshot;
}
