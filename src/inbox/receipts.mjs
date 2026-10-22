import {randomUUID} from 'node:crypto';

export async function operationReceipt(tx,{organizationId,resourceId,resourceType,state='queued'}) {
  const receipt={id:randomUUID(),resourceId,resourceType,state};
  await tx.query(`INSERT INTO outbox(id,organization_id,kind,payload) VALUES($1,$2,'inbox.operation',$3)`,
    [receipt.id,organizationId,JSON.stringify({receiptId:receipt.id,resourceId,resourceType,state})]);
  return receipt;
}
