export function applySavedSchedule(groups, sourceId, saved) {
  const schedule = { ...saved.schedule, revision: saved.revision };
  return groups.map((entry) => entry.id === sourceId ? {
    ...entry,
    schedule,
    nextScheduleCheckWithinMinutes: schedule.enabled ? schedule.cadenceMinutes : null,
  } : entry);
}
