CREATE TABLE companion_activations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), goal_id uuid NOT NULL REFERENCES companion_goals(id) ON DELETE CASCADE,
 session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, request_key uuid NOT NULL,
 authority_revision integer NOT NULL, binding text NOT NULL, root text NOT NULL, status text NOT NULL DEFAULT 'queued', resume_ids jsonb NOT NULL DEFAULT '[]', resume_generations jsonb NOT NULL DEFAULT '{}',
 result text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(goal_id,request_key), CHECK(status IN ('queued','launched','restarted','reconciled','failed','unknown'))
);
CREATE UNIQUE INDEX companion_activations_active_idx ON companion_activations((true)) WHERE status IN ('queued','launched','unknown');
CREATE TABLE companion_admission_mutex(id text PRIMARY KEY);
INSERT INTO companion_admission_mutex(id) VALUES('activation');
CREATE FUNCTION companion_admit_execution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status='running' AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
  PERFORM id FROM companion_admission_mutex WHERE id='activation' FOR SHARE;
  IF EXISTS(SELECT 1 FROM companion_activations WHERE status='launched') THEN
   RAISE EXCEPTION 'Octipus activation is in progress; no new execution was started. The request remains in conversation history.';
  END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER companion_agent_admission BEFORE INSERT OR UPDATE OF status ON agents FOR EACH ROW EXECUTE FUNCTION companion_admit_execution();
CREATE TRIGGER companion_pipeline_admission BEFORE INSERT OR UPDATE OF status ON pipelines FOR EACH ROW EXECUTE FUNCTION companion_admit_execution();
