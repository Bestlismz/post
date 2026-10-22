ALTER TABLE memberships ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0);
ALTER TABLE organizations
  ADD COLUMN business_profile jsonb NOT NULL DEFAULT '{"description":"","relevanceThreshold":60}',
  ADD COLUMN profile_revision integer NOT NULL DEFAULT 1 CHECK (profile_revision > 0),
  ADD COLUMN retention jsonb NOT NULL DEFAULT '{"rawPayloadDays":30,"screenshotDays":7}',
  ADD COLUMN retention_revision integer NOT NULL DEFAULT 1 CHECK (retention_revision > 0);
