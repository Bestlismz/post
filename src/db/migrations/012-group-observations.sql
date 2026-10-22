ALTER TABLE group_operations ADD COLUMN operation_order bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE group_operations ADD COLUMN recovery boolean NOT NULL DEFAULT false;
ALTER TABLE group_operations ADD COLUMN retry_root_id text REFERENCES group_operations(id);
ALTER TABLE group_operations ADD COLUMN retry_attempt integer NOT NULL DEFAULT 0 CHECK (retry_attempt BETWEEN 0 AND 2);
CREATE UNIQUE INDEX group_operation_retry_idx ON group_operations(retry_root_id,retry_attempt) WHERE retry_root_id IS NOT NULL;
ALTER TABLE group_sources ADD COLUMN session_circuit boolean NOT NULL DEFAULT false;
ALTER TABLE group_sources ADD COLUMN selector_circuit boolean NOT NULL DEFAULT false;
ALTER TABLE group_sources ADD COLUMN selector_failures integer NOT NULL DEFAULT 0 CHECK (selector_failures >= 0);
ALTER TABLE group_sources ADD COLUMN last_result_order bigint NOT NULL DEFAULT 0;

CREATE TABLE group_scan_receipts (
  operation_id text PRIMARY KEY,
  organization_id text NOT NULL,
  source_id text NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  selector_version text NOT NULL,
  coverage text NOT NULL CHECK (coverage IN ('complete','partial','none')),
  health text NOT NULL,
  reason text,
  cursor text,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id,operation_id) REFERENCES group_operations(organization_id,id),
  FOREIGN KEY (organization_id,source_id) REFERENCES group_sources(organization_id,id),
  UNIQUE (organization_id,operation_id)
);
CREATE TRIGGER group_scan_receipts_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON group_scan_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();

CREATE TABLE group_observations (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  source_id text NOT NULL,
  operation_id text NOT NULL,
  target_id text NOT NULL,
  post_id text NOT NULL,
  comment_id text,
  kind text NOT NULL CHECK (kind IN ('post','comment')),
  text text NOT NULL,
  author_label text NOT NULL,
  observed_at timestamptz NOT NULL,
  provider_timestamp timestamptz,
  evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  selector_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id,operation_id) REFERENCES group_scan_receipts(organization_id,operation_id),
  FOREIGN KEY (organization_id,source_id) REFERENCES group_sources(organization_id,id),
  UNIQUE (operation_id,target_id),
  UNIQUE (organization_id,id)
);
CREATE TRIGGER group_observations_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON group_observations
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();

CREATE TABLE group_targets (
  organization_id text NOT NULL,
  source_id text NOT NULL,
  target_id text NOT NULL,
  observation_id text NOT NULL,
  operation_order bigint NOT NULL,
  PRIMARY KEY (organization_id,source_id,target_id),
  FOREIGN KEY (organization_id,source_id) REFERENCES group_sources(organization_id,id),
  FOREIGN KEY (organization_id,observation_id) REFERENCES group_observations(organization_id,id)
);
