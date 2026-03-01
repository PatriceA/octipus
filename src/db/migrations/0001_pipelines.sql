-- Pipeline and Pipeline Template tables

-- Pipeline status enum
DO $$ BEGIN
    CREATE TYPE pipeline_status AS ENUM ('planning', 'running', 'paused', 'awaiting_approval', 'completed', 'failed');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Stage status enum
DO $$ BEGIN
    CREATE TYPE stage_status AS ENUM ('pending', 'running', 'awaiting_approval', 'approved', 'completed', 'failed', 'skipped');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Pipelines table
CREATE TABLE IF NOT EXISTS pipelines (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    orchestrator_agent_id TEXT NOT NULL,
    session_id UUID NOT NULL REFERENCES sessions(id),
    user_id UUID NOT NULL REFERENCES users(id),
    title TEXT NOT NULL,
    type TEXT NOT NULL,
    description TEXT,
    status pipeline_status NOT NULL DEFAULT 'planning',
    current_stage_index INTEGER NOT NULL DEFAULT 0,
    summary TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMP
);

-- Pipeline stages table
CREATE TABLE IF NOT EXISTS pipeline_stages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    pipeline_id UUID NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    model TEXT,
    skill_ids JSONB DEFAULT '[]',
    system_prompt TEXT NOT NULL,
    input TEXT NOT NULL DEFAULT '',
    output TEXT,
    worker_agent_id TEXT,
    status stage_status NOT NULL DEFAULT 'pending',
    requires_approval BOOLEAN NOT NULL DEFAULT false,
    approved_at TIMESTAMP,
    approved_by UUID REFERENCES users(id),
    stage_index INTEGER NOT NULL,
    error TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMP
);

-- Pipeline templates table
CREATE TABLE IF NOT EXISTS pipeline_templates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id),
    name TEXT NOT NULL,
    description TEXT,
    is_preset BOOLEAN NOT NULL DEFAULT false,
    steps JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Notifications table
CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id),
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    metadata JSONB DEFAULT '{}',
    read BOOLEAN NOT NULL DEFAULT false,
    delivered_channels TEXT[] DEFAULT '{}',
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS notifications_user_id_idx ON notifications(user_id);
CREATE INDEX IF NOT EXISTS notifications_read_idx ON notifications(read);
CREATE INDEX IF NOT EXISTS notifications_created_at_idx ON notifications(created_at);

-- Add topic_roles column to model_config
DO $$ BEGIN
    ALTER TABLE model_config ADD COLUMN topic_roles JSONB DEFAULT '{}';
EXCEPTION
    WHEN duplicate_column THEN null;
END $$;

-- Triggers
DO $$ BEGIN
    CREATE TRIGGER update_pipelines_updated_at
        BEFORE UPDATE ON pipelines
        FOR EACH ROW
        EXECUTE FUNCTION update_updated_at_column();
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TRIGGER update_pipeline_templates_updated_at
        BEFORE UPDATE ON pipeline_templates
        FOR EACH ROW
        EXECUTE FUNCTION update_updated_at_column();
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;
