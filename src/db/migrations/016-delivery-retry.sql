ALTER TABLE delivery_intents
  DROP CONSTRAINT delivery_intents_organization_id_authorization_id_key;

ALTER TABLE delivery_intents
  ADD COLUMN retry_of_intent_id text,
  ADD CONSTRAINT delivery_intents_retry_not_self CHECK (retry_of_intent_id IS NULL OR retry_of_intent_id <> id),
  ADD CONSTRAINT delivery_intents_retry_of_fk FOREIGN KEY (organization_id,retry_of_intent_id)
    REFERENCES delivery_intents(organization_id,id);

CREATE UNIQUE INDEX delivery_intents_root_authorization_idx
  ON delivery_intents(organization_id,authorization_id)
  WHERE retry_of_intent_id IS NULL;

CREATE UNIQUE INDEX delivery_intents_retry_once_idx
  ON delivery_intents(organization_id,retry_of_intent_id)
  WHERE retry_of_intent_id IS NOT NULL;
