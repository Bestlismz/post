CREATE TABLE delivery_attempts (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  delivery_intent_id text NOT NULL,
  state text NOT NULL CHECK(state IN ('attempting','sent','failed','unknown')),
  outcome_code text,
  provider_message_id text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  FOREIGN KEY(organization_id,delivery_intent_id) REFERENCES delivery_intents(organization_id,id),
  UNIQUE(organization_id,delivery_intent_id)
);
CREATE INDEX delivery_attempts_started_idx ON delivery_attempts(organization_id,started_at);
