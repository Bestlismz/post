CREATE TABLE login_attempts (
  organization_id text NOT NULL REFERENCES organizations(id),
  kind text NOT NULL CHECK (kind IN ('account', 'ip')),
  key_hash text NOT NULL CHECK (key_hash ~ '^[a-f0-9]{64}$'),
  attempts integer NOT NULL CHECK (attempts >= 0),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, kind, key_hash)
);
CREATE INDEX login_attempts_expiry_idx ON login_attempts (organization_id, expires_at);
