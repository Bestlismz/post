ALTER TABLE delivery_intents ALTER COLUMN source_id DROP NOT NULL;
ALTER TABLE delivery_intents ADD COLUMN group_source_id text;
ALTER TABLE delivery_intents ADD CONSTRAINT delivery_intents_group_source_fk
  FOREIGN KEY (organization_id,group_source_id) REFERENCES group_sources(organization_id,id);
ALTER TABLE delivery_intents ADD CONSTRAINT delivery_intents_exactly_one_source
  CHECK ((source_id IS NOT NULL)::integer + (group_source_id IS NOT NULL)::integer = 1);
ALTER TABLE delivery_attempts ADD CONSTRAINT delivery_attempts_organization_id_id_key UNIQUE (organization_id,id);

CREATE TABLE group_delivery_attempts (
  organization_id text NOT NULL,
  delivery_intent_id text NOT NULL,
  delivery_attempt_id text NOT NULL,
  operation_id text NOT NULL,
  target_id text NOT NULL,
  text_hash text NOT NULL CHECK (text_hash ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (organization_id,delivery_intent_id),
  FOREIGN KEY (organization_id,delivery_intent_id) REFERENCES delivery_intents(organization_id,id),
  FOREIGN KEY (organization_id,delivery_attempt_id) REFERENCES delivery_attempts(organization_id,id),
  FOREIGN KEY (organization_id,operation_id) REFERENCES group_operations(organization_id,id),
  UNIQUE (organization_id,delivery_attempt_id),
  UNIQUE (organization_id,operation_id)
);

CREATE TABLE group_send_receipts (
  operation_id text PRIMARY KEY,
  organization_id text NOT NULL,
  delivery_intent_id text NOT NULL,
  delivery_attempt_id text NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  kind text NOT NULL CHECK (kind IN ('GroupReplyResult','ReconcileResult')),
  state text NOT NULL CHECK (state IN ('sent','failed','unknown','not_found')),
  destination text NOT NULL,
  target_id text NOT NULL,
  sender_id text NOT NULL,
  text_hash text NOT NULL CHECK (text_hash ~ '^[a-f0-9]{64}$'),
  attempt_started_at timestamptz NOT NULL,
  attempt_finished_at timestamptz NOT NULL,
  evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
  remote_id text,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id,operation_id) REFERENCES group_operations(organization_id,id),
  FOREIGN KEY (organization_id,delivery_intent_id) REFERENCES delivery_intents(organization_id,id),
  FOREIGN KEY (organization_id,delivery_attempt_id) REFERENCES delivery_attempts(organization_id,id),
  UNIQUE (organization_id,operation_id)
);

CREATE TRIGGER group_delivery_attempts_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON group_delivery_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
CREATE TRIGGER group_send_receipts_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON group_send_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
