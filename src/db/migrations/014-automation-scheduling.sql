CREATE TABLE group_source_schedules (
  organization_id text NOT NULL,
  source_id text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  cadence_minutes integer NOT NULL DEFAULT 15 CHECK (cadence_minutes BETWEEN 1 AND 1440),
  time_zone text NOT NULL DEFAULT 'UTC' CHECK (length(time_zone) BETWEEN 1 AND 100),
  days smallint[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}',
  start_local text NOT NULL DEFAULT '00:00' CHECK (start_local ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'),
  end_local text NOT NULL DEFAULT '24:00' CHECK (end_local ~ '^(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]|24:00)$'),
  daily_limit integer NOT NULL DEFAULT 96 CHECK (daily_limit BETWEEN 1 AND 1440),
  maintenance_windows jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(maintenance_windows)='array'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id,source_id),
  FOREIGN KEY (organization_id,source_id) REFERENCES group_sources(organization_id,id),
  CHECK (cardinality(days)>0 AND days <@ ARRAY[0,1,2,3,4,5,6]::smallint[]),
  CHECK (start_local<>end_local)
);

CREATE TABLE group_schedule_receipts (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  source_id text NOT NULL,
  schedule_slot timestamptz NOT NULL,
  local_day date NOT NULL,
  state text NOT NULL CHECK (state IN ('scheduled','skipped')),
  reason_codes text[] NOT NULL,
  operation_id text,
  job_id text REFERENCES jobs(id),
  schedule_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id,source_id) REFERENCES group_sources(organization_id,id),
  FOREIGN KEY (organization_id,operation_id) REFERENCES group_operations(organization_id,id),
  UNIQUE (organization_id,source_id,schedule_slot),
  CHECK ((state='scheduled' AND cardinality(reason_codes)=0 AND operation_id IS NOT NULL AND job_id IS NOT NULL)
      OR (state='skipped' AND cardinality(reason_codes)>0 AND operation_id IS NULL AND job_id IS NULL))
);
CREATE INDEX group_schedule_daily_idx ON group_schedule_receipts(organization_id,source_id,local_day,state);

CREATE TABLE automation_control_receipts (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  scope text NOT NULL CHECK (scope IN ('organization','source')),
  source_id text,
  paused boolean NOT NULL,
  reason_code text NOT NULL CHECK (reason_code IN ('GLOBAL_PAUSED','GLOBAL_RESUMED','SOURCE_PAUSED','SOURCE_RESUMED')),
  actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id,actor_id) REFERENCES memberships(organization_id,user_id),
  FOREIGN KEY (organization_id,source_id) REFERENCES group_sources(organization_id,id),
  CHECK ((scope='organization' AND source_id IS NULL) OR (scope='source' AND source_id IS NOT NULL))
);

CREATE TRIGGER group_schedule_receipts_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON group_schedule_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
CREATE TRIGGER automation_control_receipts_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON automation_control_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
