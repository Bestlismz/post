CREATE TABLE meta_oauth_states (
  state_hash text PRIMARY KEY,
  organization_id text NOT NULL,
  actor_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  FOREIGN KEY (organization_id, actor_id) REFERENCES memberships(organization_id, user_id)
);
CREATE TABLE meta_page_sources (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  page_id text NOT NULL,
  name text NOT NULL,
  health text NOT NULL CHECK (health IN ('connected','revoked','expired','disconnected','unavailable')),
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, page_id),
  UNIQUE (organization_id, id)
);
CREATE TABLE meta_credentials (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  actor_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('pending','page')),
  envelope jsonb NOT NULL,
  expires_at timestamptz,
  FOREIGN KEY (organization_id, actor_id) REFERENCES memberships(organization_id, user_id)
);
-- The runtime can use only these scoped operations, never project the table.
-- Fully qualified relations and a fixed search path exclude caller/temp objects.
DO $migration$
DECLARE s text := current_schema();
BEGIN
  EXECUTE format('CREATE FUNCTION meta_credential_read(text,text) RETURNS TABLE(actor_id text,kind text,envelope jsonb,expires_at timestamptz) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS %L',
    format('SELECT actor_id,kind,envelope,expires_at FROM %I.meta_credentials WHERE organization_id=$1 AND id=$2', s));
  EXECUTE format('CREATE FUNCTION meta_credential_write(text,text,text,text,jsonb,timestamptz) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS %L',
    format('INSERT INTO %I.meta_credentials(id,organization_id,actor_id,kind,envelope,expires_at) VALUES($2,$1,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET actor_id=EXCLUDED.actor_id,kind=EXCLUDED.kind,envelope=EXCLUDED.envelope,expires_at=EXCLUDED.expires_at WHERE %I.meta_credentials.organization_id=EXCLUDED.organization_id', s, s));
  EXECUTE format('CREATE FUNCTION meta_credential_delete(text,text) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS %L',
    format('DELETE FROM %I.meta_credentials WHERE organization_id=$1 AND id=$2', s));
END;
$migration$;
REVOKE ALL ON FUNCTION meta_credential_read(text,text), meta_credential_write(text,text,text,text,jsonb,timestamptz), meta_credential_delete(text,text) FROM PUBLIC;
