-- Mounted skills have stable external: ids but no row in skills.
DO $$ DECLARE constraint_name text; BEGIN
  FOR constraint_name IN SELECT conname FROM pg_constraint
    WHERE conrelid = 'skill_topic_assignments'::regclass AND confrelid = 'skills'::regclass
  LOOP EXECUTE format('ALTER TABLE skill_topic_assignments DROP CONSTRAINT %I', constraint_name); END LOOP;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION delete_skill_topic_assignments() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN DELETE FROM skill_topic_assignments WHERE skill_id = OLD.id; RETURN OLD; END $$;
--> statement-breakpoint
CREATE TRIGGER skill_topic_assignments_cleanup AFTER DELETE ON skills
FOR EACH ROW EXECUTE FUNCTION delete_skill_topic_assignments();
