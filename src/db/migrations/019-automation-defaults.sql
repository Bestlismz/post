ALTER TABLE organizations ALTER COLUMN automation_policy SET DEFAULT
  '{"mode":"approval","minimumConfidence":0.82,"rateLimits":{"organization":100,"source":20,"conversation":2},"businessHours":{"timeZone":"Asia/Bangkok","days":[0,1,2,3,4,5,6],"start":"00:00","end":"24:00"}}'::jsonb;

UPDATE organizations
SET automation_policy = '{"mode":"approval","minimumConfidence":0.82,"rateLimits":{"organization":100,"source":20,"conversation":2},"businessHours":{"timeZone":"Asia/Bangkok","days":[0,1,2,3,4,5,6],"start":"00:00","end":"24:00"}}'::jsonb,
    automation_policy_revision = automation_policy_revision + 1
WHERE NOT (automation_policy ? 'minimumConfidence')
   OR NOT (automation_policy ? 'rateLimits')
   OR NOT (automation_policy ? 'businessHours');

ALTER TABLE group_sources ALTER COLUMN policy SET DEFAULT
  '{"rateLimits":{"organization":100,"source":20,"conversation":2},"businessHours":{"timeZone":"Asia/Bangkok","days":[0,1,2,3,4,5,6],"start":"00:00","end":"24:00"}}'::jsonb;

UPDATE group_sources
SET policy = '{"rateLimits":{"organization":100,"source":20,"conversation":2},"businessHours":{"timeZone":"Asia/Bangkok","days":[0,1,2,3,4,5,6],"start":"00:00","end":"24:00"}}'::jsonb,
    revision = revision + 1,
    updated_at = now()
WHERE NOT (policy ? 'rateLimits') OR NOT (policy ? 'businessHours');

INSERT INTO group_source_schedules(
  organization_id, source_id, enabled, cadence_minutes, time_zone, days,
  start_local, end_local, daily_limit, maintenance_windows, revision
)
SELECT organization_id, id, true, 15, 'Asia/Bangkok', '{0,1,2,3,4,5,6}',
  '00:00', '24:00', 96, '[]'::jsonb, 1
FROM group_sources
WHERE NOT archived
ON CONFLICT (organization_id, source_id) DO NOTHING;
