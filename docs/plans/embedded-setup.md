# Plan: Embedded Database Support + Setup Wizard

> Generated 2026-03-08. Execute phases consecutively — each is self-contained.

## Architecture Overview

```
bun run setup
  ├─ Infrastructure mode?
  │   ├─ [Embedded]  PGlite + in-memory cache (zero external deps)
  │   └─ [External]  PostgreSQL + Redis (production)
  ├─ Optional extras?
  │   ├─ [ ] Playwright browser automation
  │   ├─ [ ] Voice plugin
  │   └─ [ ] Ollama local LLM
  └─ Writes .env → starts migrations → ready

Config key: STORAGE_MODE=embedded|external  (new env var)
```

---

## Allowed APIs (verified via docs + web research)

### PGlite
```ts
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
const client = await PGlite.create({ dataDir: './data', extensions: { vector } });
await client.exec('CREATE EXTENSION IF NOT EXISTS vector');
await client.query('SELECT 1');
await client.close();
```

### Drizzle + PGlite
```ts
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
const db = drizzle({ client, schema });
await migrate(db, { migrationsFolder: './src/db/migrations' });
```

### @inquirer/prompts (Bun-compatible)
```ts
import { input, select, confirm, checkbox } from '@inquirer/prompts';
const answer = await select({ message: 'Mode?', choices: [...] });
```

**Anti-pattern:** Do NOT use `@clack/prompts` — has unresolved Bun stdin bugs.

---

## Phase 1: Storage Provider Abstraction Layer

**Goal:** Abstract Redis behind interfaces so both ioredis and in-memory implementations work.

### What to implement

Create `src/db/storage/` directory with:

1. **`src/db/storage/types.ts`** — Interfaces extracted from current `RedisCache`, `RedisQueue`, `RedisPubSub` signatures:

```ts
export interface CacheProvider {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  increment(key: string, by?: number): Promise<number>;
  expire(key: string, ttlSeconds: number): Promise<void>;
  ttl(key: string): Promise<number>;
}

export interface QueueProvider {
  push(item: unknown, priority?: number): Promise<void>;
  pop(): Promise<unknown | null>;
  peek(): Promise<unknown | null>;
  length(): Promise<number>;
  clear(): Promise<void>;
}

export interface PubSubProvider {
  publish(channel: string, message: unknown): Promise<void>;
  subscribe(channel: string, handler: (message: unknown) => void): Promise<void>;
  unsubscribe(channel: string, handler?: (message: unknown) => void): Promise<void>;
}

export interface StorageProvider {
  createCache(prefix: string, defaultTtl?: number): CacheProvider;
  createQueue(name: string): QueueProvider;
  createPubSub(): PubSubProvider;
  /** Raw get/setex/del for simple key-value (used by oauth.ts, linking.ts) */
  getRaw(key: string): Promise<string | null>;
  setRaw(key: string, value: string, ttlSeconds: number): Promise<void>;
  delRaw(key: string): Promise<void>;
  /** Health check */
  ping(): Promise<boolean>;
  close(): Promise<void>;
}
```

2. **`src/db/storage/redis-provider.ts`** — Wraps existing `src/db/redis.ts` code:
   - Constructor takes ioredis config (url, keyPrefix, maxRetries, retryDelay)
   - `createCache()` returns existing `RedisCache` (adapted to interface)
   - `createQueue()` returns existing `RedisQueue` (adapted)
   - `createPubSub()` returns existing `RedisPubSub` (adapted)
   - `getRaw/setRaw/delRaw` delegate to ioredis directly
   - Copy patterns from `src/db/redis.ts:1-150` (RedisCache, RedisQueue, RedisPubSub)

3. **`src/db/storage/memory-provider.ts`** — In-process implementation:
   - **MemoryCache**: `Map<string, { value: string; expiresAt: number }>` with TTL sweep interval
   - **MemoryQueue**: `Array<{ item: string; score: number }>` sorted by score (mimics ZADD)
   - **MemoryPubSub**: `EventEmitter` per channel
   - `getRaw/setRaw/delRaw` use the same Map

4. **`src/db/storage/index.ts`** — Factory:
   ```ts
   export function getStorageProvider(): StorageProvider { ... }
   export function initializeStorage(mode: 'embedded' | 'external', config: ...): void { ... }
   export function closeStorage(): Promise<void> { ... }
   ```

### Files to modify (wire up)

| File | Change |
|------|--------|
| `src/db/redis.ts` | Keep as-is but deprecate direct usage. Add thin wrappers that delegate to `getStorageProvider()` |
| `src/db/index.ts` | Export `getStorageProvider` alongside existing exports |
| `src/security/auth/session.ts` | Already uses `RedisCache` — no change needed if redis.ts delegates |
| `src/security/rate-limiter.ts` | Same — uses `RedisCache` |
| `src/security/oauth.ts` | Replace `getRedis().setex/get/del` → `getStorageProvider().setRaw/getRaw/delRaw` |
| `src/channels/linking.ts` | Same as oauth.ts — replace raw ioredis calls |
| `src/core/gateway.ts` | Initialize storage provider based on config mode |
| `src/config/schema.ts` | Add `mode` field to redis config section |

### Documentation references
- Current Redis code: `src/db/redis.ts` (all classes)
- Raw ioredis usage: `src/security/oauth.ts:22-34`, `src/channels/linking.ts:15-30`
- Config schema: `src/config/schema.ts:12-17`

### Verification checklist
- [ ] `bun test` passes (existing tests)
- [ ] Backend starts in `external` mode with real Redis — identical behavior
- [ ] Backend starts in `embedded` mode without Redis — sessions, caching, rate limiting, pub/sub, queues all work
- [ ] Run `curl http://localhost:3005/api/health` in both modes

### Anti-pattern guards
- Do NOT remove the existing `src/db/redis.ts` — keep it as the Redis implementation
- Do NOT change the `RedisCache`/`RedisQueue`/`RedisPubSub` class APIs — they become the interface contract
- Do NOT add Lua scripting or transactions — not needed (confirmed by audit)
- Memory provider TTL cleanup: use `setInterval` sweep, NOT per-access lazy cleanup (avoids memory leaks)

---

## Phase 2: PGlite Database Driver

**Goal:** Support PGlite as an alternative to PostgreSQL via config.

### What to implement

1. **Install dependency:**
   ```bash
   bun add @electric-sql/pglite
   ```

2. **`src/db/postgres.ts`** — Refactor to support both drivers:

   Current (lines 1-2):
   ```ts
   import { drizzle } from 'drizzle-orm/postgres-js';
   import postgres from 'postgres';
   ```

   New pattern — conditional driver based on config:
   ```ts
   // Keep both drivers available via dynamic import
   // Config: database.mode = 'embedded' | 'external'

   async function initExternal(config): Promise<DrizzleDB> {
     const postgres = (await import('postgres')).default;
     const { drizzle } = await import('drizzle-orm/postgres-js');
     const sql = postgres(config.database.url, { max: config.database.poolSize, ... });
     return drizzle(sql, { schema });
   }

   async function initEmbedded(dataDir: string): Promise<DrizzleDB> {
     const { PGlite } = await import('@electric-sql/pglite');
     const { vector } = await import('@electric-sql/pglite/vector');
     const { drizzle } = await import('drizzle-orm/pglite');
     const client = await PGlite.create({ dataDir, extensions: { vector } });
     await client.exec('CREATE EXTENSION IF NOT EXISTS vector');
     return drizzle({ client, schema });
   }
   ```

   Key changes:
   - `getDb()` calls `initExternal()` or `initEmbedded()` based on config
   - `closeDb()` handles both `sql.end()` and `client.close()`
   - `executeRaw()` uses `sql.unsafe()` or `client.exec()`
   - `checkDbHealth()` uses template literal or `client.query()`

3. **`src/db/migrate.ts`** — Dual migrator:

   Current (line 1): `import { migrate } from 'drizzle-orm/postgres-js/migrator'`

   New: conditional import based on mode:
   ```ts
   if (mode === 'embedded') {
     const { migrate } = await import('drizzle-orm/pglite/migrator');
     // ...
   } else {
     const { migrate } = await import('drizzle-orm/postgres-js/migrator');
     // ...
   }
   ```

4. **`src/config/schema.ts`** — Add mode to database config (line 4):
   ```ts
   z.object({
     mode: z.enum(['embedded', 'external']).default('external'),
     url: z.string().optional(),  // required only for external
     dataDir: z.string().default('~/.assistant/data'),  // for embedded
     poolSize: ...,
   })
   ```

5. **`src/config/defaults.ts`** — Add defaults for embedded mode

### Documentation references
- PGlite constructor: `PGlite.create({ dataDir, extensions: { vector } })`
- PGlite Drizzle: `drizzle-orm/pglite` driver, `drizzle-orm/pglite/migrator`
- Current DB init: `src/db/postgres.ts:13-34`
- Current migrations: `src/db/migrate.ts:1-49`
- Config schema: `src/config/schema.ts:4-9`

### Verification checklist
- [ ] `bun run db:migrate` works in embedded mode (creates PGlite data dir, runs all 9 migrations)
- [ ] `bun run dev` starts with `STORAGE_MODE=embedded` and no PostgreSQL running
- [ ] All API endpoints work (sessions, messages, models, etc.)
- [ ] RAG/embeddings work (vector search with pgvector in PGlite)
- [ ] `bun run dev` still works with `STORAGE_MODE=external` (existing PostgreSQL)

### Anti-pattern guards
- Do NOT change the Drizzle schema files — same schema for both backends
- Do NOT use `new PGlite()` — use `PGlite.create()` (awaits internal ready)
- Do NOT put PGlite data in the project dir — use `~/.assistant/data/` (user data dir)
- Embedded mode is NOT for production multi-user — log a warning if detected
- Keep `initializeExtensions()` working for both modes (PGlite loads vector via constructor + CREATE EXTENSION)

---

## Phase 3: Setup Wizard Enhancement

**Goal:** Replace the basic readline setup with an interactive wizard that handles mode selection, optional extras, and auto-detection.

### What to implement

1. **Install dependency:**
   ```bash
   bun add -D @inquirer/prompts
   ```
   Note: `-D` because setup is a dev/admin tool, not runtime.

2. **Rewrite `scripts/setup.ts`** — Keep the ASCII banner, replace readline with @inquirer/prompts:

   **Flow:**
   ```
   1. Auto-detect: check if PostgreSQL and Redis are reachable
   2. Infrastructure mode selection:
      - If both detected → suggest External, offer Embedded as option
      - If neither detected → suggest Embedded, offer External as option
      - If partial → explain what's missing, suggest accordingly
   3. If External mode:
      - Prompt for PostgreSQL host/port/db/user/password (current flow)
      - Prompt for Redis host/port/password (current flow)
   4. If Embedded mode:
      - Data directory (default: ~/.assistant/data)
      - No DB/Redis prompts needed
   5. API server: port, host (keep current)
   6. Security keys: auto-generate (keep current)
   7. Optional extras (checkbox):
      - [ ] Playwright (browser automation for QA agent)
            → runs: bunx playwright install chromium
      - [ ] Voice plugin
            → runs: bun add @anthropic-ai/voice (or whatever the package is)
      - [ ] Ollama (local LLM)
            → checks if ollama is installed, if not: suggests install command
      - [ ] SearXNG (search engine)
            → shows Docker command
   8. Write .env file
   9. Run migrations
   10. Show summary + next steps
   ```

3. **Auto-detection helpers** (in setup script):
   ```ts
   async function checkPostgres(url: string): Promise<boolean> {
     try {
       // Quick TCP connect to port or use pg to connect
       const response = await fetch(`http://localhost:5432`).catch(() => null);
       // Better: use Bun.connect for TCP check
       return true;
     } catch { return false; }
   }

   async function checkRedis(url: string): Promise<boolean> {
     // TCP connect to port 6379
   }

   async function checkOllama(): Promise<boolean> {
     // fetch http://localhost:11434/api/tags
   }
   ```

4. **Plugin installer** — after .env is written:
   ```ts
   async function installExtras(selected: string[]): Promise<void> {
     for (const extra of selected) {
       console.log(`\nInstalling ${extra}...`);
       const proc = Bun.spawn(INSTALL_COMMANDS[extra], { stdio: ['inherit', 'inherit', 'inherit'] });
       await proc.exited;
     }
   }
   ```

### Documentation references
- Current setup: `scripts/setup.ts` (full file, 139 lines)
- @inquirer/prompts: `input()`, `select()`, `confirm()`, `checkbox()` — see API section above
- Config schema: `src/config/schema.ts` — where new mode field goes

### Verification checklist
- [ ] `bun run setup` runs interactively, all prompts work in Bun
- [ ] Selecting "Embedded" creates .env with `STORAGE_MODE=embedded`, no DB/Redis URLs
- [ ] Selecting "External" creates .env with DB/Redis URLs (current behavior preserved)
- [ ] Auto-detection correctly identifies running PostgreSQL/Redis
- [ ] Optional extras install commands execute successfully
- [ ] After setup, `bun run dev` starts successfully in the chosen mode
- [ ] Existing `.env` files (no STORAGE_MODE) default to `external` (backward compatible)

### Anti-pattern guards
- Do NOT make @inquirer/prompts a runtime dependency — dev only
- Do NOT block setup if extras fail to install — warn and continue
- Do NOT delete existing .env without confirmation
- Do NOT assume PostgreSQL/Redis are on default ports — always offer port config
- Keep the ASCII banner — it's nice

---

## Phase 4: Config + Startup Integration

**Goal:** Wire the mode selection into config schema, bootstrap loader, and startup flow.

### What to implement

1. **`src/config/schema.ts`** — Add storage mode:
   ```ts
   // New top-level field (line ~161):
   storageMode: z.enum(['embedded', 'external']).default('external'),

   // Modify database schema to make url optional:
   database: z.object({
     mode: z.enum(['embedded', 'external']).optional(), // derived from storageMode
     url: z.string().optional(),  // was: z.string().url()
     dataDir: z.string().default('~/.assistant/data'),
     poolSize: ...,
   }),

   // Modify redis schema to make url optional:
   redis: z.object({
     mode: z.enum(['embedded', 'external']).optional(),
     url: z.string().optional(),  // was: z.string().default('redis://...')
     keyPrefix: ...,
   }),
   ```

2. **`src/config/bootstrap-loader.ts`** — Read `STORAGE_MODE` from env:
   ```ts
   const storageMode = process.env.STORAGE_MODE || 'external';
   // If embedded: don't require DATABASE_URL or REDIS_URL
   // If external: require both (current behavior)
   ```

3. **`src/config/defaults.ts`** — Update required env vars:
   - `DATABASE_URL` only required when `STORAGE_MODE=external`
   - `REDIS_URL` only required when `STORAGE_MODE=external`
   - `MASTER_KEY`, `JWT_SECRET`, `SESSION_SECRET` always required

4. **`src/core/gateway.ts`** — Update init flow:
   ```ts
   // Current (line ~30): getRedis()
   // New: initializeStorage(config.storageMode, config.redis)

   // Current (line ~25): getDb() + initializeExtensions()
   // New: already handled by refactored postgres.ts
   ```

5. **`src/index.ts`** — Log storage mode on startup:
   ```ts
   console.log(`Storage mode: ${config.storageMode}`);
   if (config.storageMode === 'embedded') {
     console.log('Running with embedded PGlite + in-memory cache');
     console.log('Data directory:', config.database.dataDir);
   }
   ```

6. **`.env.example`** — Update with new vars:
   ```env
   # Storage mode: 'embedded' (zero deps) or 'external' (PostgreSQL + Redis)
   STORAGE_MODE=external

   # External mode only:
   DATABASE_URL=postgresql://assistant:password@localhost:5432/assistant
   REDIS_URL=redis://localhost:6379

   # Embedded mode only:
   # DATA_DIR=~/.assistant/data
   ```

### Documentation references
- Bootstrap loader: `src/config/bootstrap-loader.ts`
- Config schema: `src/config/schema.ts:161-180`
- Gateway init: `src/core/gateway.ts`
- Main entry: `src/index.ts:24-80`
- Env example: `.env.example`

### Verification checklist
- [ ] `STORAGE_MODE=embedded bun run dev` starts without PostgreSQL or Redis
- [ ] `STORAGE_MODE=external bun run dev` starts with PostgreSQL + Redis (current behavior)
- [ ] Missing `STORAGE_MODE` defaults to `external` (backward compatible)
- [ ] `STORAGE_MODE=embedded` without `DATABASE_URL` doesn't error
- [ ] `STORAGE_MODE=external` without `DATABASE_URL` errors clearly
- [ ] Health endpoint reports storage mode

### Anti-pattern guards
- Do NOT change the hot-reload block for database/redis — they remain bootstrap-only
- Do NOT allow switching modes at runtime — restart required
- Do NOT force embedded mode in production — log a prominent warning
- Existing `.env` files without `STORAGE_MODE` must keep working (default: external)

---

## Phase 5: Verification & Documentation

**Goal:** End-to-end testing + update docs.

### What to verify

1. **Fresh install (embedded):**
   ```bash
   git clone ... && cd assistant
   bun install
   bun run setup       # choose Embedded
   bun run dev          # should start with zero external deps
   # Open http://localhost:3005/setup → create admin account
   # Send a chat message → orchestrator + worker should work
   ```

2. **Fresh install (external):**
   ```bash
   bun run setup       # choose External, provide PG + Redis URLs
   bun run dev          # should start with external services
   ```

3. **Upgrade (existing .env):**
   ```bash
   # Existing user with .env containing DATABASE_URL + REDIS_URL
   git pull
   bun install
   bun run dev          # should work exactly as before (STORAGE_MODE defaults to external)
   ```

4. **Feature parity test matrix:**

| Feature | External | Embedded |
|---------|----------|----------|
| Chat sessions | ✅ | ✅ |
| Agent spawning | ✅ | ✅ |
| Tool execution | ✅ | ✅ |
| RAG/embeddings | ✅ | ✅ |
| Rate limiting | ✅ | ✅ |
| Session auth | ✅ | ✅ |
| Settings hot-reload | ✅ | ✅ (in-process pub/sub) |
| Task scheduling | ✅ | ✅ |
| Multi-instance | ✅ | ❌ (expected) |

### Documentation updates

- **README.md** — Add "Quick Start (Embedded)" section before current setup instructions
- **docs/AGENT-ARCHITECTURE.md** — Add storage modes section
- **.env.example** — Already updated in Phase 4

### Anti-pattern guards
- Do NOT skip the upgrade path test — backward compatibility is critical
- Do NOT mark embedded as "production ready" — it's single-user/dev
- Do NOT remove Docker setup docs — they're still needed for external mode
