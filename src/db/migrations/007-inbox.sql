CREATE TABLE conversations (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  channel text NOT NULL DEFAULT 'messenger' CHECK (channel = 'messenger'),
  page_id text NOT NULL,
  psid text NOT NULL,
  processing_revision integer NOT NULL DEFAULT 0 CHECK (processing_revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, page_id, psid),
  UNIQUE (organization_id, id)
);

CREATE TABLE messages (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  conversation_id text NOT NULL,
  page_id text NOT NULL,
  mid text NOT NULL,
  direction text NOT NULL DEFAULT 'inbound' CHECK (direction = 'inbound'),
  text text NOT NULL,
  provider_timestamp_ms bigint,
  processing_revision integer NOT NULL CHECK (processing_revision > 0),
  raw_evidence jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, conversation_id) REFERENCES conversations(organization_id, id),
  UNIQUE (organization_id, page_id, mid),
  UNIQUE (conversation_id, processing_revision),
  UNIQUE (organization_id, id)
);

CREATE TABLE work_items (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  conversation_id text NOT NULL,
  message_id text NOT NULL UNIQUE,
  processing_revision integer NOT NULL CHECK (processing_revision > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'preparing', 'needs_review', 'ready', 'completed', 'superseded', 'handoff', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, conversation_id) REFERENCES conversations(organization_id, id),
  FOREIGN KEY (organization_id, message_id) REFERENCES messages(organization_id, id),
  UNIQUE (organization_id, id)
);
CREATE INDEX work_items_queue_idx ON work_items (organization_id, created_at, id);
