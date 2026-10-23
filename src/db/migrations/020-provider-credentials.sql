ALTER TABLE meta_credentials DROP CONSTRAINT meta_credentials_kind_check;
ALTER TABLE meta_credentials ADD CONSTRAINT meta_credentials_kind_check
  CHECK (kind IN ('pending','page','openai'));
