# Configuration precedence

Two stores, two stages. Knowing which wins when is important.

## TL;DR

- **`.env`** is bootstrap-only. Read once on first boot, then ignored.
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
| `STORAGE_MODE`            | `.env`       | re-run `bun run setup` and pick           |
| `DATABASE_URL`            | `.env`       | `.env` directly (external mode only)      |
| `DATA_DIR`                | `.env`       | `.env` directly (embedded mode only)      |
| `MASTER_KEY`              | `.env`       | regenerate with care — see warning below  |
| `JWT_SECRET`              | `.env`       | regenerate (invalidates sessions)         |
| `SESSION_SECRET`          | `.env`       | regenerate (invalidates sessions)         |
| `PORT` / `HOST`           | `.env`       | edit + restart                            |
| `BOOTSTRAP_PROVIDER` etc. | `.env`       | first-boot only; no effect once a model is in DB |
| LLM provider configs      | DB `model_config` | Models page / API                    |
| Channel tokens            | Vault        | Channels page                             |
| Topic → role bindings     | DB `settings` | Models page                              |
| Persona presets           | DB `profiles`, YAML in `personas/` | `/persona ...` slash command |
| Workspace path            | DB `settings` | UI / API                                 |

## "I edited my .env but nothing changed"

That's expected for any field tracked in `settings`. After first boot,
DB wins. To force a re-seed from `.env`, delete the
`_system.envMigrated` row in the `settings` table and restart — the
migration runs again and overwrites DB values with the current .env.

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

The split is annoying once. The fix is `octi doctor`, which tells you
exactly what's missing from each side.

## Rotating the master key

Don't. The master key encrypts every vault entry — rotating it makes
existing API keys, channel tokens, and SSO secrets unrecoverable.

If you genuinely need to rotate (compromised key, fresh install), the
safe procedure is:
1. Export every vault entry's plaintext via the Secrets page.
2. Generate a new `MASTER_KEY` and put it in `.env`.
3. Restart Octipus.
4. Re-add every secret via the UI.

`bun run setup` will refuse to overwrite an existing `MASTER_KEY` for
this reason.
