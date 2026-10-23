DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rental_radar_web') THEN
    GRANT SELECT, INSERT, UPDATE (state, outcome_code, finished_at)
      ON TABLE group_comment_edits TO rental_radar_web;
  END IF;
END
$$;
