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

ALTER TABLE organizations ADD COLUMN automation_policy jsonb NOT NULL DEFAULT '{"mode":"approval"}',
  ADD COLUMN automation_policy_revision integer NOT NULL DEFAULT 1 CHECK (automation_policy_revision>0),
  ADD COLUMN reply_format jsonb,
  ADD COLUMN reply_format_revision integer NOT NULL DEFAULT 1 CHECK (reply_format_revision>0);
ALTER TABLE conversations ADD COLUMN human_takeover boolean NOT NULL DEFAULT false,
  ADD COLUMN opted_out boolean NOT NULL DEFAULT false;

CREATE TABLE reply_versions (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  work_item_id text NOT NULL,
  conversation_id text NOT NULL,
  conversation_revision integer NOT NULL CHECK (conversation_revision>0),
  version integer NOT NULL CHECK (version>0),
  content jsonb NOT NULL,
  context jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id,work_item_id) REFERENCES work_items(organization_id,id),
  FOREIGN KEY (organization_id,conversation_id) REFERENCES conversations(organization_id,id),
  UNIQUE(organization_id,id), UNIQUE(organization_id,work_item_id,version)
);
CREATE TABLE reply_supersessions (
  organization_id text NOT NULL,
  reply_version_id text NOT NULL,
  replacement_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,reply_version_id),
  FOREIGN KEY(organization_id,reply_version_id) REFERENCES reply_versions(organization_id,id),
  FOREIGN KEY(organization_id,replacement_id) REFERENCES reply_versions(organization_id,id)
);
CREATE TABLE reply_authorizations (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  work_item_id text NOT NULL,
  reply_version_id text NOT NULL,
  actor_kind text NOT NULL CHECK(actor_kind IN ('human','policy')),
  actor_id text,
  evidence jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(organization_id,work_item_id) REFERENCES work_items(organization_id,id),
  FOREIGN KEY(organization_id,reply_version_id) REFERENCES reply_versions(organization_id,id),
  FOREIGN KEY(organization_id,actor_id) REFERENCES memberships(organization_id,user_id),
  UNIQUE(organization_id,work_item_id), UNIQUE(organization_id,id)
);
CREATE TABLE delivery_intents (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  authorization_id text NOT NULL,
  reply_version_id text NOT NULL,
  conversation_id text NOT NULL,
  source_id text NOT NULL,
  content jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(organization_id,authorization_id) REFERENCES reply_authorizations(organization_id,id),
  FOREIGN KEY(organization_id,reply_version_id) REFERENCES reply_versions(organization_id,id),
  FOREIGN KEY(organization_id,conversation_id) REFERENCES conversations(organization_id,id),
  FOREIGN KEY(organization_id,source_id) REFERENCES meta_page_sources(organization_id,id),
  UNIQUE(organization_id,authorization_id), UNIQUE(organization_id,id)
);
CREATE TABLE delivery_cancellations (
  organization_id text NOT NULL,
  delivery_intent_id text NOT NULL,
  reason text NOT NULL,
  actor_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,delivery_intent_id),
  FOREIGN KEY(organization_id,delivery_intent_id) REFERENCES delivery_intents(organization_id,id),
  FOREIGN KEY(organization_id,actor_id) REFERENCES memberships(organization_id,user_id)
);
CREATE FUNCTION reject_reply_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Reply and authorization ledgers are immutable'; END;
$$;
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['reply_versions','reply_supersessions','reply_authorizations','delivery_intents','delivery_cancellations'] LOOP
    EXECUTE format('CREATE TRIGGER immutable_ledger BEFORE UPDATE OR DELETE OR TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_reply_ledger_mutation()',relation);
  END LOOP;
END $$;
