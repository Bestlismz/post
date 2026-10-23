ALTER TABLE group_observations
  ADD COLUMN reaction_count integer CHECK (reaction_count IS NULL OR reaction_count >= 0),
  ADD COLUMN comment_count integer CHECK (comment_count IS NULL OR comment_count >= 0);

ALTER TABLE group_operations DROP CONSTRAINT group_operations_kind_check;
ALTER TABLE group_operations ADD CONSTRAINT group_operations_kind_check
  CHECK (kind IN ('ScanCommand','GroupReplyCommand','GroupEditCommand','ReconcileCommand'));

ALTER TABLE group_send_receipts DROP CONSTRAINT group_send_receipts_kind_check;
ALTER TABLE group_send_receipts ADD CONSTRAINT group_send_receipts_kind_check
  CHECK (kind IN ('GroupReplyResult','GroupEditResult','ReconcileResult'));

CREATE TABLE group_comment_edits (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  delivery_intent_id text NOT NULL,
  operation_id text NOT NULL,
  idempotency_key text NOT NULL,
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 4000),
  state text NOT NULL CHECK (state IN ('attempting','sent','failed','unknown')),
  provider_message_id text NOT NULL,
  outcome_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  FOREIGN KEY (organization_id,delivery_intent_id) REFERENCES delivery_intents(organization_id,id),
  FOREIGN KEY (organization_id,operation_id) REFERENCES group_operations(organization_id,id),
  UNIQUE (organization_id,idempotency_key),
  UNIQUE (organization_id,operation_id)
);

CREATE TRIGGER group_comment_edits_immutable BEFORE DELETE OR TRUNCATE ON group_comment_edits
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
