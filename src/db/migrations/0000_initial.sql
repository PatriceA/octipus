-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
-- pgvector for embeddings (optional - install via: apt-get install postgresql-15-pgvector)
-- CREATE EXTENSION IF NOT EXISTS vector;

-- Create enums
DO $$ BEGIN
    CREATE TYPE session_status AS ENUM ('active', 'paused', 'completed', 'failed');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE message_role AS ENUM ('system', 'user', 'assistant', 'tool');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE audit_action AS ENUM (
        'login', 'logout', 'login_failed',
        'session_created', 'session_completed',
        'message_sent', 'tool_executed',
        'permission_requested', 'permission_granted', 'permission_denied',
        'credential_accessed', 'credential_created', 'credential_updated', 'credential_deleted',
        'settings_changed',
        'user_created', 'user_updated', 'user_deleted',
        'agent_spawned', 'agent_completed', 'agent_failed',
        'hook_triggered', 'mcp_connected', 'mcp_disconnected'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE credential_type AS ENUM ('api_key', 'oauth_token', 'password', 'ssh_key', 'certificate', 'other');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE trigger_type AS ENUM (
        'message_received', 'agent_started', 'agent_completed', 'agent_failed',
        'tool_executed', 'permission_requested', 'schedule', 'webhook'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE action_type AS ENUM ('notify', 'spawn_agent', 'webhook', 'n8n_workflow', 'execute_skill');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE permission_level AS ENUM ('ALLOW', 'ASK', 'DENY');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username TEXT NOT NULL UNIQUE,
    email TEXT UNIQUE,
    password_hash TEXT,
    is_admin BOOLEAN NOT NULL DEFAULT false,
    is_active BOOLEAN NOT NULL DEFAULT true,
    totp_secret TEXT,
    totp_enabled BOOLEAN NOT NULL DEFAULT false,
    passkey_credentials JSONB DEFAULT '[]',
    channel_bindings JSONB DEFAULT '[]',
    preferences JSONB DEFAULT '{}',
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    last_login_at TIMESTAMP
);

-- Sessions table
CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id),
    channel_type TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    thread_id TEXT,
    title TEXT,
    status session_status NOT NULL DEFAULT 'active',
    context JSONB DEFAULT '{}',
    metadata JSONB DEFAULT '{}',
    message_count INTEGER NOT NULL DEFAULT 0,
    token_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMP
);

-- Messages table
CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role message_role NOT NULL,
    content TEXT NOT NULL,
    tool_calls JSONB,
    tool_call_id TEXT,
    tool_name TEXT,
    agent_id TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS messages_session_id_idx ON messages(session_id);
CREATE INDEX IF NOT EXISTS messages_created_at_idx ON messages(created_at);
CREATE INDEX IF NOT EXISTS messages_agent_id_idx ON messages(agent_id);

-- Embeddings table (requires pgvector extension)
-- Uncomment below if pgvector is installed
-- CREATE TABLE IF NOT EXISTS embeddings (
--     id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
--     source_type TEXT NOT NULL,
--     source_id UUID NOT NULL,
--     content TEXT NOT NULL,
--     embedding vector(1536),
--     model TEXT NOT NULL,
--     metadata JSONB DEFAULT '{}',
--     created_at TIMESTAMP NOT NULL DEFAULT NOW()
-- );
-- CREATE INDEX IF NOT EXISTS embeddings_source_type_idx ON embeddings(source_type);
-- CREATE INDEX IF NOT EXISTS embeddings_source_id_idx ON embeddings(source_id);
-- CREATE INDEX IF NOT EXISTS embeddings_embedding_idx ON embeddings USING hnsw (embedding vector_cosine_ops);

-- Audit log table
CREATE TABLE IF NOT EXISTS audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id),
    action audit_action NOT NULL,
    resource_type TEXT,
    resource_id TEXT,
    details JSONB DEFAULT '{}',
    ip_address INET,
    user_agent TEXT,
    channel_type TEXT,
    session_id UUID,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_log_user_id_idx ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS audit_log_action_idx ON audit_log(action);
CREATE INDEX IF NOT EXISTS audit_log_resource_type_idx ON audit_log(resource_type);
CREATE INDEX IF NOT EXISTS audit_log_created_at_idx ON audit_log(created_at);

-- Vault table (encrypted credentials)
CREATE TABLE IF NOT EXISTS vault (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    credential_type credential_type NOT NULL,
    encrypted_value TEXT NOT NULL,
    encryption_iv TEXT NOT NULL,
    encryption_auth_tag TEXT NOT NULL,
    description TEXT,
    tags TEXT[] DEFAULT '{}',
    metadata JSONB DEFAULT '{}',
    allowed_skills TEXT[] DEFAULT '{}',
    allowed_agents TEXT[] DEFAULT '{}',
    is_active BOOLEAN NOT NULL DEFAULT true,
    expires_at TIMESTAMP,
    last_accessed_at TIMESTAMP,
    access_count TEXT DEFAULT '0',
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS vault_user_id_idx ON vault(user_id);
CREATE INDEX IF NOT EXISTS vault_name_idx ON vault(name);
CREATE INDEX IF NOT EXISTS vault_type_idx ON vault(credential_type);

-- Model config table
CREATE TABLE IF NOT EXISTS model_config (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL UNIQUE,
    provider TEXT NOT NULL,
    model_id TEXT NOT NULL,
    endpoint TEXT,
    api_key_ref TEXT,
    max_tokens INTEGER NOT NULL DEFAULT 4096,
    context_window INTEGER NOT NULL DEFAULT 128000,
    supports_vision BOOLEAN NOT NULL DEFAULT false,
    supports_tools BOOLEAN NOT NULL DEFAULT true,
    supports_streaming BOOLEAN NOT NULL DEFAULT true,
    default_temperature REAL DEFAULT 0.7,
    default_top_p REAL DEFAULT 1.0,
    default_max_tokens INTEGER DEFAULT 4096,
    topics TEXT[] DEFAULT '{}',
    priority INTEGER NOT NULL DEFAULT 0,
    cost_per_input_token REAL NOT NULL DEFAULT 0,
    cost_per_output_token REAL NOT NULL DEFAULT 0,
    is_enabled BOOLEAN NOT NULL DEFAULT true,
    is_default BOOLEAN NOT NULL DEFAULT false,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS model_config_provider_idx ON model_config(provider);
CREATE INDEX IF NOT EXISTS model_config_topics_idx ON model_config USING GIN(topics);

-- Cost log table
CREATE TABLE IF NOT EXISTS cost_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL,
    session_id UUID,
    agent_id TEXT,
    model_name TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    total_cost REAL NOT NULL,
    request_type TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS cost_log_user_id_idx ON cost_log(user_id);
CREATE INDEX IF NOT EXISTS cost_log_session_id_idx ON cost_log(session_id);
CREATE INDEX IF NOT EXISTS cost_log_model_name_idx ON cost_log(model_name);
CREATE INDEX IF NOT EXISTS cost_log_created_at_idx ON cost_log(created_at);

-- Hooks table
CREATE TABLE IF NOT EXISTS hooks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    description TEXT,
    trigger trigger_type NOT NULL,
    trigger_config JSONB NOT NULL,
    action action_type NOT NULL,
    action_config JSONB NOT NULL,
    conditions JSONB DEFAULT '[]',
    is_enabled BOOLEAN NOT NULL DEFAULT true,
    priority INTEGER NOT NULL DEFAULT 0,
    max_executions INTEGER,
    execution_count INTEGER NOT NULL DEFAULT 0,
    cooldown_ms INTEGER DEFAULT 0,
    last_executed_at TIMESTAMP,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS hooks_user_id_idx ON hooks(user_id);
CREATE INDEX IF NOT EXISTS hooks_trigger_idx ON hooks(trigger);
CREATE INDEX IF NOT EXISTS hooks_is_enabled_idx ON hooks(is_enabled);

-- Skill permissions table
CREATE TABLE IF NOT EXISTS skill_permissions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id),
    skill_id TEXT NOT NULL,
    action TEXT NOT NULL,
    level permission_level NOT NULL,
    conditions JSONB DEFAULT '[]',
    granted_by UUID REFERENCES users(id),
    reason TEXT,
    expires_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT user_skill_action_unique UNIQUE(user_id, skill_id, action)
);

CREATE INDEX IF NOT EXISTS skill_permissions_user_id_idx ON skill_permissions(user_id);
CREATE INDEX IF NOT EXISTS skill_permissions_skill_id_idx ON skill_permissions(skill_id);

-- Permission requests table
CREATE TABLE IF NOT EXISTS permission_requests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id),
    agent_id TEXT NOT NULL,
    session_id UUID,
    skill_id TEXT NOT NULL,
    action TEXT NOT NULL,
    context JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    resolved_by UUID REFERENCES users(id),
    resolved_at TIMESTAMP,
    resolution TEXT,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS permission_requests_user_id_idx ON permission_requests(user_id);
CREATE INDEX IF NOT EXISTS permission_requests_status_idx ON permission_requests(status);
CREATE INDEX IF NOT EXISTS permission_requests_agent_id_idx ON permission_requests(agent_id);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Add triggers for updated_at
DO $$ BEGIN
    CREATE TRIGGER update_users_updated_at
        BEFORE UPDATE ON users
        FOR EACH ROW
        EXECUTE FUNCTION update_updated_at_column();
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TRIGGER update_sessions_updated_at
        BEFORE UPDATE ON sessions
        FOR EACH ROW
        EXECUTE FUNCTION update_updated_at_column();
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TRIGGER update_vault_updated_at
        BEFORE UPDATE ON vault
        FOR EACH ROW
        EXECUTE FUNCTION update_updated_at_column();
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TRIGGER update_model_config_updated_at
        BEFORE UPDATE ON model_config
        FOR EACH ROW
        EXECUTE FUNCTION update_updated_at_column();
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TRIGGER update_hooks_updated_at
        BEFORE UPDATE ON hooks
        FOR EACH ROW
        EXECUTE FUNCTION update_updated_at_column();
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TRIGGER update_skill_permissions_updated_at
        BEFORE UPDATE ON skill_permissions
        FOR EACH ROW
        EXECUTE FUNCTION update_updated_at_column();
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;
