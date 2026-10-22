import { ZodError } from "zod";
import { httpError } from "../auth/authorize.mjs";

export function commandFor(request, input, create = false) {
  const idempotencyKey = request.get("Idempotency-Key");
  if (!idempotencyKey?.trim()) throw httpError(422, "Invalid request", { idempotencyKey: ["Idempotency-Key is required"] });
  const raw = request.get("If-Match");
  const revision = raw?.replace(/^"(\d+)"$/, "$1");
  if (!create && (!revision || !/^[1-9]\d*$/.test(revision) || !Number.isSafeInteger(Number(revision)))) throw httpError(409, "Current If-Match revision is required");
  return { organizationId: request.actor.organizationId, actorId: request.actor.id, idempotencyKey, ...(create ? {} : { expectedRevision: Number(revision) }), input };
}
export function sendEntity(response, entity, status = 200) {
  if (entity.revision) response.set("ETag", `"${entity.revision}"`);
  return response.status(status).json(entity);
}
export function errorHandler(error, _request, response, _next) {
  let status = error.status ?? 500, fieldErrors = error.fieldErrors ?? {};
  let message = status === 500 ? "Internal server error" : error.message;
  if (error.type === "entity.parse.failed") {
    status = 400;
    message = "Invalid JSON";
  } else if (error instanceof ZodError) {
    status = 422;
    message = "Invalid request";
    fieldErrors = {};
    for (const issue of error.issues) (fieldErrors[issue.path.join(".") || "body"] ??= []).push(issue.message);
  } else if (error.fields) {
    fieldErrors = Object.fromEntries(error.fields.map((field) => [field, ["Required for publication"]]));
  } else if (error.code === "23505") { status = 409; message = "Resource already exists"; }
  response.status(status).json({ error: message, fieldErrors });
}
