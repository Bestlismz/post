export function nextScheduleCheckWithinMinutes(row) {
  if(!row.schedule_revision||!row.schedule_enabled)return null;
  const cadence=Number(row.schedule_cadence_minutes);
  return Number.isSafeInteger(cadence)&&cadence>0?cadence:null;
}

export function operationState(row) {
  if(row.operation_completed)return 'completed';
  if(row.operation_job_status==='failed')return 'failed';
  if(row.operation_job_status==='running'||row.operation_job_status==='attempting')return row.operation_job_status;
  if(row.operation_stuck)return 'stuck';
  if(row.operation_job_status==='completed')return 'awaiting_result';
  return row.operation_job_status??'queued';
}
