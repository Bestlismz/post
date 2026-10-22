CREATE TABLE legacy_state_imports (
  organization_id text PRIMARY KEY REFERENCES organizations(id),
  source_checksum text NOT NULL CHECK (source_checksum ~ '^[a-f0-9]{64}$'),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  counts jsonb NOT NULL CHECK (jsonb_typeof(counts) = 'object'),
  delivery_outcomes jsonb NOT NULL CHECK (jsonb_typeof(delivery_outcomes) = 'object'),
  imported_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION reject_legacy_import_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Legacy imports are immutable';
END;
$$;
CREATE TRIGGER legacy_state_imports_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON legacy_state_imports
  FOR EACH STATEMENT EXECUTE FUNCTION reject_legacy_import_mutation();
