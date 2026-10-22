import { Router } from "express";
import { requireRole, httpError } from "../auth/authorize.mjs";
import { createCatalog } from "../inventory/catalog.mjs";
import { getProject, getUnit } from "../inventory/repository.mjs";
import { withTransaction } from "../db/transaction.mjs";
import { commandFor, sendEntity } from "./boundary.mjs";

export function inventoryRoutes({ pool, write }) {
  const router = Router(), catalog = createCatalog(pool);
  const editor = requireRole("admin", "inventory_manager");
  for (const [resource, singular, get] of [["projects", "Project", getProject], ["units", "Unit", getUnit]]) {
    router.get(`/api/${resource}`, async (request, response) => {
      const entities = await withTransaction(pool, async (tx) => {
        const ids = await tx.query(`SELECT id FROM ${resource} WHERE organization_id=$1 ORDER BY id`, [request.actor.organizationId]);
        return Promise.all(ids.rows.map(({ id }) => get(tx, request.actor.organizationId, id)));
      });
      response.json({ [resource]: entities });
    });
    router.get(`/api/${resource}/:id`, async (request, response) => {
      const entity = await withTransaction(pool, (tx) => get(tx, request.actor.organizationId, request.params.id));
      if (!entity) throw httpError(404, `${singular} not found`);
      sendEntity(response, entity);
    });
    router.post(`/api/${resource}`, ...write, editor, async (request, response) => sendEntity(response, await catalog[`create${singular}`](commandFor(request, request.body, true)), 201));
    router.patch(`/api/${resource}/:id`, ...write, editor, async (request, response) => sendEntity(response, await catalog[`update${singular}`](commandFor(request, { ...request.body, id: request.params.id }))));
    router.delete(`/api/${resource}/:id`, (_request, _response, next) => next(httpError(405, "Archive inventory instead of deleting it")));
  }
  for (const [route, action] of [["publish", "publishUnit"], ["availability", "changeAvailability"], ["archive", "archiveUnit"]]) {
    router.post(`/api/units/:id/${route}`, ...write, editor, async (request, response) => sendEntity(response, await catalog[action](commandFor(request, { ...request.body, id: request.params.id }))));
  }
  return router;
}
