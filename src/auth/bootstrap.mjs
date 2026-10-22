import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hashPassword } from "./password.mjs";
import { appendAudit, withTransaction } from "../db/transaction.mjs";

export const newUserInput = z.strictObject({ email: z.email().transform((value) => value.toLowerCase()), password: z.string().min(12).max(1024), displayName: z.string().trim().min(1).max(200) });
export async function bootstrapAdmin(pool, input) {
  const user = newUserInput.parse(input);
  const passwordHash = await hashPassword(user.password);
  return withTransaction(pool, async (tx) => {
    await tx.query("SELECT id FROM organizations WHERE id='org_default' FOR UPDATE");
    const existing = await tx.query("SELECT 1 FROM memberships WHERE organization_id='org_default' AND role='admin' LIMIT 1");
    if (existing.rowCount) throw new Error("An admin already exists; bootstrap is disabled");
    const id = randomUUID();
    await tx.query("INSERT INTO users (id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)", [id, user.email, passwordHash, user.displayName]);
    await tx.query("INSERT INTO memberships (organization_id,user_id,role) VALUES ('org_default',$1,'admin')", [id]);
    await appendAudit(tx, { organizationId: "org_default", actorId: id, action: "user.bootstrapped", entityType: "user", entityId: id });
    return { id, email: user.email, role: "admin" };
  });
}
