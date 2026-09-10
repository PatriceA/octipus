# Configuration precedence

Two stores, two stages. Knowing which wins when is important.

## TL;DR

- **`.env`** supplies bootstrap fields on every start. Registered runtime settings and secrets migrate to DB/vault on first boot; later environment edits do not replace those stored values. Some process-level controls (for example `GATEWAY_STDIO` and artifact hosting variables) are still read directly from the environment.
- **DB `settings` table** is the runtime source of truth. Changed via the
  web UI, `/settings` API, or directly. Survives restarts.
- **Vault** (encrypted `vault` table) holds secrets. Referenced by name
  from settings.
- **Hot-reload** picks up DB changes without a restart (where the
  consuming module subscribes — most LLM/router settings, not all).

## The boot sequence

```
.env file (and process env)
   │
   │  read by  src/config/bootstrap-loader.ts
   ▼
Bootstrap config in memory
   STORAGE_MODE, DATABASE_URL,
   MASTER_KEY, JWT_SECRET, SESSION_SECRET,
   PORT, HOST
   │
   ▼
DB initialized + migrations run
   │
   ▼
First boot only:
  migrateEnvToDb  ─────► populates DB `settings` from .env
  bootstrapDefaultModel ► seeds model_config from BOOTSTRAP_PROVIDER + key
   │
   ▼
Settings service warms cache from DB
   │
   ▼
Runtime: every getConfig() call reads the in-memory cache, which
mirrors the DB. DB writes hot-reload through the cache.
```

## Which keys live where

| Key                       | Store        | Edit via                                  |
| ------------------------- | ------------ | ----------------------------------------- |
| `STORAGE_MODE`            | `.env`       | re-run `npm run setup` and pick           |
| `DATABASE_URL`            | `.env`       | `.env` directly (external mode only)      |
| `DATA_DIR`                | `.env`       | `.env` directly (embedded mode only)      |
| `MASTER_KEY`              | `.env`       | regenerate with care — see warning below  |
| `JWT_SECRET`              | `.env`       | regenerate (invalidates sessions)         |
| `SESSION_SECRET`          | `.env`       | regenerate (invalidates sessions)         |
| `PORT` / `HOST`           | `.env`       | edit + restart                            |
| `BOOTSTRAP_PROVIDER` etc. | `.env`       | first-boot only; no effect once a model is in DB |
| LLM provider configs      | DB `model_config` | Models page / API                    |
| Channel tokens            | Vault        | Channels page                             |
| Topic → model bindings    | DB `model_config.topic_roles`, `topics_config` | Topics / Models page or API |
| Persona presets           | DB `profiles`, YAML in `personas/` | `/persona ...` slash command |
| Workspace path            | DB `settings` | UI / API                                 |

## "I edited my .env but nothing changed"

That's expected for any field tracked in `settings`. After first boot,
DB wins. Edit those values through Settings or the API. Removing the
`_system.envMigrated` sentinel reruns migration, but does not force an
overwrite: existing non-default settings and existing vault secrets are
preserved (`src/config/migrate-env-to-db.ts`).

For bootstrap-only fields (`STORAGE_MODE`, `DATABASE_URL`,
`MASTER_KEY`, …), the .env IS the source of truth — but you must
restart for changes to take effect since they're read at boot time.

## "Why two stores?"

Practical reasons:
1. **Storage mode + DB URL** must be readable BEFORE the DB
   connection is open. They live in `.env`.
2. **Security keys** must be available before the vault is unlocked.
   They live in `.env`.
3. **Everything else** benefits from web UI editability, audit
   trails, and multi-user scoping. Lives in DB.

Use `octi doctor` for available environment and service checks; it is not a complete configuration audit.

## Rotating the master key

Changing `MASTER_KEY` alone makes existing vault ciphertext unreadable. Use
`scripts/rotate-master-key.ts` to re-encrypt active vault rows:

1. Back up the database and preserve the old key securely; stop backend writers.
2. Export `OLD_MASTER_KEY`, `NEW_MASTER_KEY` (at least 32 characters each),
   and the deployment's storage variables in the maintenance shell.
3. Run `npx tsx scripts/rotate-master-key.ts --dry-run` to count candidates.
   This dry-run does not prove that each row can be decrypted.
4. Run `npx tsx scripts/rotate-master-key.ts`. Inspect the final `failed` count:
   partial row failures are logged but currently do **not** cause a nonzero exit.
   Resolve them before changing the deployment key. Re-running the same old/new
   pair skips rows already rotated.
5. Set deployment `MASTER_KEY` to the new key, restart, and verify vault reads.

The script rotates active rows only and does not modify deployment environment
files. Keep the backup and old key according to your recovery requirements.
