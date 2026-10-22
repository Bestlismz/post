import { randomUUID } from "node:crypto";
import { appendAudit, runIdempotent, withTransaction } from "../db/transaction.mjs";
import { validateCommand, validatePublication } from "./schemas.mjs";
import { getProject, getUnit, saveProject, saveUnit } from "./repository.mjs";

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
