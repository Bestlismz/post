import { randomUUID } from "node:crypto";
import { z } from "zod";
import { enqueueJob } from "../jobs/queue.mjs";
import { matchInventory, requirementsSchema, policySchema } from "./matcher.mjs";
import { snapshotUnitFacts } from "./facts.mjs";
import { appendAudit, runIdempotent, withTransaction } from "../db/transaction.mjs";
import { validateCommand, validatePublication } from "./schemas.mjs";
import { getProject, getUnit, saveProject, saveUnit, saveSnapshot } from "./repository.mjs";

const transitions = {
  draft: ["unknown", "available"],
  unknown: ["draft", "available"],
  available: ["unknown", "held", "rented"],
  held: ["available", "rented", "unknown"],
  rented: ["available", "unknown"],
};
function fail(message, status) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

export function createCatalog(pool) {
  const catalog = {};
  catalog.saveMatchSnapshot = async (command) => {
    const id = z.string().min(1), revision = z.number().int().positive();
    z.object({ organizationId: id, actorId: id, idempotencyKey: id }).parse(command);
    const input = z.strictObject({
      requirementsRevision: revision, requirements: requirementsSchema, policy: policySchema.default({}),
      expectedInventory: z.array(z.strictObject({ unitId: id, unitRevision: revision, projectId: id, projectRevision: revision })).max(1000),
    }).parse(command.input);
    if (new Set(input.expectedInventory.map(entry => entry.unitId)).size !== input.expectedInventory.length) fail("Duplicate inventory evidence", 422);
    const { organizationId, actorId, idempotencyKey } = command;
    const response = await withTransaction(pool, tx => runIdempotent(tx, {
      organizationId, actorId, route: "inventory.saveMatchSnapshot", key: idempotencyKey, body: command.input,
    }, async () => {
      const units = [];
      // All writers lock units before projects. Sorted locks make overlapping snapshots agree.
      for (const evidence of [...input.expectedInventory].sort((a, b) => a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0)) {
        const unit = await getUnit(tx, organizationId, evidence.unitId);
        if (!unit || unit.revision !== evidence.unitRevision || unit.projectId !== evidence.projectId || !unit.publishedAt || unit.status !== "available") fail("Inventory changed; match again", 409);
        units.push(unit);
      }
      const projects = new Map();
      for (const projectId of [...new Set(input.expectedInventory.map(entry => entry.projectId))].sort()) projects.set(projectId, await getProject(tx, organizationId, projectId));
      for (const unit of units) {
        const evidence = input.expectedInventory.find(entry => entry.unitId === unit.id);
        unit.project = projects.get(unit.projectId);
        if (!unit.project || unit.project.revision !== evidence.projectRevision) fail("Inventory changed; match again", 409);
      }
      const result = matchInventory(input.requirements, units, input.policy);
      const snapshot = await saveSnapshot(tx, {
        id: randomUUID(), organizationId, requirementsRevision: input.requirementsRevision,
        requirements: input.requirements, policy: input.policy, matcherVersion: result.matcherVersion,
        inventoryWatermark: units.map(unit => ({ unitId: unit.id, unitRevision: unit.revision, projectId: unit.projectId, projectRevision: unit.project.revision })),
        candidates: result.candidates, factSnapshot: result.candidates.map(candidate => snapshotUnitFacts(units.find(unit => unit.id === candidate.unitId))),
      });
      await appendAudit(tx, { organizationId, actorId, action: "match.snapshot_created", entityType: "match_snapshot", entityId: snapshot.id, details: { requirementsRevision: input.requirementsRevision, matcherVersion: result.matcherVersion, inventoryWatermark: snapshot.inventoryWatermark } });
      await enqueueJob(tx, { organizationId, kind: "match.snapshot_created", payload: { snapshotId: snapshot.id }, retrySafe: true });
      return { status: 201, body: snapshot };
    }));
    return response.body;
  };
  for (const action of ["createProject", "updateProject", "createUnit", "updateUnit", "publishUnit", "changeAvailability", "archiveUnit"]) {
    catalog[action] = async (command) => {
      const input = validateCommand(action, command);
      const { organizationId, actorId, idempotencyKey, expectedRevision } = command;
      const response = await withTransaction(pool, (tx) => runIdempotent(tx, {
        organizationId, actorId, route: `inventory.${action}`, key: idempotencyKey,
        body: { input: command.input, expectedRevision: expectedRevision ?? null },
      }, async () => {
        const projectCommand = action.endsWith("Project");
        const create = action.startsWith("create");
        let current;
        if (!create) {
          current = await (projectCommand ? getProject(tx, organizationId, input.id, true) : getUnit(tx, organizationId, input.id));
          if (!current) fail(`${projectCommand ? "Project" : "Unit"} not found`, 404);
          if (current.revision !== expectedRevision) fail("Revision conflict", 409);
          if (current.status === "archived") fail("Unit is archived", 409);
        }
        const { id: ignoredId, ...patch } = input;
        let entity = { ...(create ? { media: [], ...(projectCommand ? { transit: [], amenities: [] } : { status: "draft", publishedAt: null }) } : current), ...patch,
          id: current?.id ?? randomUUID(), organizationId, revision: (current?.revision ?? 0) + 1 };
        let event;
        if (projectCommand) {
          entity = await saveProject(tx, entity, create);
          event = create ? "project.created" : "project.updated";
        } else {
          const project = await getProject(tx, organizationId, entity.projectId);
          if (!project) fail("Project not found", 404);
          if (action === "publishUnit") {
            validatePublication(entity);
            if (entity.status !== "available") fail("Only available units can publish", 422);
            entity.publishedAt = new Date().toISOString();
          }
          if (action === "changeAvailability" && !transitions[current.status]?.includes(input.status)) fail(`Illegal availability transition ${current.status} -> ${input.status}`, 409);
          if (action === "archiveUnit") entity.status = "archived";
          if (entity.publishedAt) validatePublication(entity);
          entity.factsUpdatedAt = new Date().toISOString();
          entity = await saveUnit(tx, entity, project, create);
          event = { createUnit: "unit.created", updateUnit: "unit.updated", publishUnit: "unit.published", changeAvailability: "unit.availability_changed", archiveUnit: "unit.archived" }[action];
        }
        await appendAudit(tx, { organizationId, actorId, action: event, entityType: projectCommand ? "project" : "unit", entityId: entity.id,
          details: { revision: entity.revision, previousRevision: current?.revision ?? null, ...(projectCommand ? {} : { status: entity.status, previousStatus: current?.status ?? null }) } });
        return { status: create ? 201 : 200, body: entity };
      }));
      return response.body;
    };
  }
  return catalog;
}
