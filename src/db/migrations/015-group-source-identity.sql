ALTER TABLE group_sources
  ADD COLUMN display_name text CHECK (display_name IS NULL OR (char_length(display_name) BETWEEN 1 AND 300)),
  ADD COLUMN access_level text NOT NULL DEFAULT 'unknown' CHECK (access_level IN ('unknown','reader','admin'));
