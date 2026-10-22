ALTER TABLE conversations DROP CONSTRAINT conversations_channel_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_channel_check CHECK (channel IN ('messenger','facebook_group'));
ALTER TABLE organizations ADD COLUMN group_automation_paused boolean NOT NULL DEFAULT false;

CREATE TABLE group_sources (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  group_id text NOT NULL CHECK (group_id ~ '^[0-9]+$'),
  canonical_url text NOT NULL CHECK (canonical_url = 'https://www.facebook.com/groups/' || group_id),
  mode text NOT NULL DEFAULT 'observe' CHECK (mode IN ('observe','approval','automatic')),
  allow_listed boolean NOT NULL DEFAULT false,
  policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  session_health text NOT NULL DEFAULT 'unknown' CHECK (session_health IN ('unknown','healthy','auth_required','failed')),
  selector_health text NOT NULL DEFAULT 'unknown' CHECK (selector_health IN ('unknown','healthy','failed')),
  selector_version text,
  kill_switch boolean NOT NULL DEFAULT false,
  archived boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,group_id),
  UNIQUE (organization_id,id)
);
CREATE TABLE group_operations (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  source_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('ScanCommand','GroupReplyCommand','ReconcileCommand')),
  command jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id,source_id) REFERENCES group_sources(organization_id,id),
  UNIQUE (organization_id,id)
);
CREATE TRIGGER group_operations_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON group_operations
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
