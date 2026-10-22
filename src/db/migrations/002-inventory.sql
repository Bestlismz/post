CREATE TABLE projects (
  organization_id text NOT NULL REFERENCES organizations(id),
  id text NOT NULL,
  name text NOT NULL,
  address text,
  district text,
  province text,
  latitude double precision CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision CHECK (longitude BETWEEN -180 AND 180),
  media jsonb NOT NULL DEFAULT '[]',
  revision integer NOT NULL CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id)
);

CREATE TABLE project_transit (
  organization_id text NOT NULL,
  project_id text NOT NULL,
  project_revision integer NOT NULL CHECK (project_revision > 0),
  position integer NOT NULL CHECK (position >= 0),
  station text NOT NULL,
  walking_distance_m integer NOT NULL CHECK (walking_distance_m >= 0),
  PRIMARY KEY (organization_id, project_id, project_revision, position),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id)
);

CREATE TABLE project_amenities (
  organization_id text NOT NULL,
  project_id text NOT NULL,
  project_revision integer NOT NULL CHECK (project_revision > 0),
  position integer NOT NULL CHECK (position >= 0),
  name text NOT NULL,
  PRIMARY KEY (organization_id, project_id, project_revision, position),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id)
);

CREATE TABLE units (
  organization_id text NOT NULL,
  id text NOT NULL,
  project_id text NOT NULL,
  unit_code text NOT NULL,
  room_type text,
  bedrooms integer CHECK (bedrooms >= 0),
  bathrooms integer CHECK (bathrooms >= 0),
  floor integer,
  area_sqm double precision CHECK (area_sqm > 0),
  monthly_rent_thb double precision CHECK (monthly_rent_thb > 0),
  deposit_months double precision CHECK (deposit_months >= 0),
  advance_months double precision CHECK (advance_months >= 0),
  pet_policy text CHECK (pet_policy IN ('allowed','case_by_case','not_allowed','unknown')),
  available_from date,
  description text,
  status text NOT NULL CHECK (status IN ('draft','unknown','available','held','rented','archived')),
  published_at timestamptz,
  facts_updated_at timestamptz NOT NULL DEFAULT now(),
  media jsonb NOT NULL DEFAULT '[]',
  revision integer NOT NULL CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, project_id, unit_code),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id)
);

CREATE TABLE unit_fact_revisions (
  organization_id text NOT NULL,
  unit_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  facts jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, unit_id, revision),
  FOREIGN KEY (organization_id, unit_id) REFERENCES units(organization_id, id)
);

CREATE FUNCTION reject_unit_fact_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Unit fact revisions are immutable';
END;
$$;
CREATE TRIGGER unit_fact_revisions_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON unit_fact_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_unit_fact_mutation();
CREATE INDEX units_match_idx ON units (organization_id, status, available_from, monthly_rent_thb) WHERE published_at IS NOT NULL;
