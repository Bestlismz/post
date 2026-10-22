CREATE TABLE match_snapshots (
  organization_id text NOT NULL REFERENCES organizations(id),
  id text NOT NULL,
  requirements_revision integer NOT NULL CHECK (requirements_revision > 0),
  requirements jsonb NOT NULL,
  policy jsonb NOT NULL,
  matcher_version text NOT NULL,
  inventory_watermark jsonb NOT NULL,
  candidates jsonb NOT NULL,
  fact_snapshot jsonb NOT NULL CHECK (jsonb_typeof(fact_snapshot) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id)
);
CREATE FUNCTION reject_match_snapshot_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Match snapshots are immutable';
END;
$$;
CREATE TRIGGER match_snapshots_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON match_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION reject_match_snapshot_mutation();
