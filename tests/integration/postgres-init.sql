-- Postgres init for the integration test container.
--
-- Runs as the bootstrap superuser (POSTGRES_USER=postgres). Creates the
-- non-superuser `octipus` app role that tests connect as. With the role
-- demoted from SUPERUSER+BYPASSRLS, the RLS policies installed by
-- migration 0034 actually fire under the test transactions, matching
-- production behavior. Extensions that need superuser (pgvector,
-- uuid-ossp) are pre-created here so the demoted role can run idempotent
-- `CREATE EXTENSION IF NOT EXISTS` migrations without privilege errors.
\connect octipus_test

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE ROLE octipus
  LOGIN PASSWORD 'test'
  NOSUPERUSER NOBYPASSRLS
  CREATEDB CREATEROLE;

GRANT ALL PRIVILEGES ON DATABASE octipus_test TO octipus;
GRANT ALL ON SCHEMA public TO octipus;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO octipus;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO octipus;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO octipus;
