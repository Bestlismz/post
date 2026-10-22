CREATE TABLE organizations (
  id text PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO organizations (id, name) VALUES ('org_default', 'Rental Radar');

CREATE TABLE users (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  organization_id text NOT NULL REFERENCES organizations(id),
  user_id text NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('admin', 'operator', 'inventory_manager', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);

CREATE TABLE sessions (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  user_id text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  csrf_token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, user_id) REFERENCES memberships(organization_id, user_id)
);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

CREATE TABLE idempotency_keys (
  organization_id text NOT NULL REFERENCES organizations(id),
  actor_id text NOT NULL,
  route text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, actor_id, route, key),
  FOREIGN KEY (organization_id, actor_id) REFERENCES memberships(organization_id, user_id)
);

CREATE TABLE audit_entries (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  actor_id text,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, actor_id) REFERENCES memberships(organization_id, user_id)
);
CREATE INDEX audit_entries_organization_created_idx ON audit_entries (organization_id, created_at, id);

CREATE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Audit entries are append-only';
END;
$$;
CREATE TRIGGER audit_entries_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_entries
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();

CREATE TABLE jobs (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  retry_safe boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'attempting', 'completed', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_claim_idx ON jobs (status, available_at, lease_expires_at);

CREATE TABLE outbox (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX outbox_unpublished_idx ON outbox (created_at, id) WHERE published_at IS NULL;
