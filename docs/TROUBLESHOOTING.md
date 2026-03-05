# Troubleshooting

## pgvector Extension Requires Superuser

**Problem**: `CREATE EXTENSION vector` fails with "permission denied".

**Solution**: Install using the database superuser:
```bash
docker exec <db-container> psql -U <superuser> -d assistant \
  -c "CREATE EXTENSION IF NOT EXISTS vector;"
```
The migration handles this gracefully — if the extension can't be created, it logs a warning and continues without vector search.

## Migration Error: "Can't find meta/_journal.json"

**Problem**: Drizzle ORM migrations fail because the metadata journal file is missing.

**Solution**:
```bash
mkdir -p src/db/migrations/meta
```
Create `src/db/migrations/meta/_journal.json`:
```json
{
  "version": "7",
  "dialect": "postgresql",
  "entries": [
    {
      "idx": 0,
      "version": "7",
      "when": 1708000000000,
      "tag": "0000_initial",
      "breakpoints": true
    }
  ]
}
```

## Collation Version Mismatch Warning

**Problem**: PostgreSQL warns about collation version mismatch.

**Cause**: Database created with a different OS/glibc version. Harmless.

**Solution** (optional):
```sql
ALTER DATABASE assistant REFRESH COLLATION VERSION;
```

## Model Registry Duplicate Key on Restart

**Problem**: Server crashes with `Key (name)=(cli/codex-cli) already exists`.

**Status**: Fixed — the model registry now checks existence regardless of `isEnabled` status.

## Database Connection Failed

```bash
# Check PostgreSQL is running
cd ~/docker-services && docker compose ps db

# Start if stopped
docker compose up -d db

# Verify connection
docker exec <db-container> psql -U <user> -d assistant -c "SELECT 1;"
```

## Redis Connection Failed

```bash
cd ~/docker-services && docker compose ps redis
docker compose up -d redis
docker exec <redis-container> redis-cli ping
```

## LiteLLM Not Running

```bash
cd ~/docker-services
docker compose up -d litellm
docker compose logs litellm
curl http://localhost:4000/health
```

## Port Conflicts

```bash
lsof -i :3005   # Backend
lsof -i :3007   # Web UI

# Or change ports in .env
API_PORT=3008
WEB_PORT=3009
```

## Browser Tool: Playwright Not Installed

```bash
bunx playwright install chromium
```
