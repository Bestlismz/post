export function sourceFromRow(row) {
  if(!row) return null;
  return {id:row.id,organizationId:row.organization_id,groupId:row.group_id,canonicalUrl:row.canonical_url,mode:row.mode,allowListed:row.allow_listed,policy:row.policy,sessionHealth:row.session_health,selectorHealth:row.selector_health,selectorVersion:row.selector_version,killSwitch:row.kill_switch,archived:row.archived,revision:row.revision};
}
export async function getGroupSource(tx,organizationId,id) {
  const {rows:[row]}=await tx.query('SELECT * FROM group_sources WHERE organization_id=$1 AND id=$2 FOR UPDATE',[organizationId,id]);
  return sourceFromRow(row);
}
export async function insertGroupSource(tx,source) {
  const result=await tx.query('INSERT INTO group_sources(id,organization_id,group_id,canonical_url) VALUES($1,$2,$3,$4) ON CONFLICT(organization_id,group_id) DO NOTHING RETURNING *',[source.id,source.organizationId,source.groupId,source.canonicalUrl]);
  if(result.rowCount) return {source:sourceFromRow(result.rows[0]),created:true};
  const {rows:[row]}=await tx.query('SELECT * FROM group_sources WHERE organization_id=$1 AND group_id=$2 FOR UPDATE',[source.organizationId,source.groupId]);
  return {source:sourceFromRow(row),created:false};
}
export async function saveGroupSource(tx,source) {
  const {rows:[row]}=await tx.query(`UPDATE group_sources SET mode=$3,allow_listed=$4,policy=$5,kill_switch=$6,archived=$7,revision=revision+1,updated_at=now() WHERE organization_id=$1 AND id=$2 RETURNING *`,[source.organizationId,source.id,source.mode,source.allowListed,JSON.stringify(source.policy),source.killSwitch,source.archived]);
  return sourceFromRow(row);
}
export async function insertGroupOperation(tx,organizationId,command) {
  await tx.query('INSERT INTO group_operations(id,organization_id,source_id,kind,command) VALUES($1,$2,$3,$4,$5)',[command.operationId,organizationId,command.sourceId,command.kind,JSON.stringify(command)]);
}
