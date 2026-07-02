/**
 * Capability service — persists the availability of every optional
 * tool / external binary into the `capabilities` table, and exposes
 * the read+install API the orchestrator and CLI consume.
 *
 * Probes are done by each tool's own `checkAvailability()` (already
 * implemented per BaseTool). This service only orchestrates the runs
 * and persists results. Installers live in `src/tools/<name>/install.ts`
 * and are loaded lazily so the boot probe never imports them.
 *
 * Boot lifecycle (src/index.ts):
 *   1. runMigrations + seeds
 *   2. tool registry initialization
 *   3. capabilityService.probeAll()  ← writes table
 *   4. orchestrator reads `getAvailable()` when spawning agents
 */

import { eq } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { capabilities, type CapabilityRow } from '@/db/schema/capabilities';
import { getToolRegistry } from '@/tools/registry';
import { logger } from '@/utils/logger';

export type InstallerKind = 'bun-exec' | 'shell' | 'npm-build' | 'copy' | 'manual';

export interface InstallResult {
  ok: boolean;
  /** Free-form message — success summary or failure reason. */
  detail: string;
  /** Output captured from the installer command, if any. */
  output?: string;
}

export interface InstallerModule {
  /** Required: how the install is dispatched. */
  kind: InstallerKind;
  /** Required: run the install. Must not throw — return { ok: false }. */
  install: () => Promise<InstallResult>;
  /** Optional: tool version once installed, e.g. "playwright@1.49.0". */
  version?: () => Promise<string | null>;
}

/**
 * Map from capabilityId → dynamic import path. Installers are loaded
 * only on demand so the boot probe doesn't pay their import cost.
 * Tool installers live next to their tool (`src/tools/<name>/install.ts`);
 * non-tool installers (services like ollama, the MCP server build) live
 * under `src/capabilities/installers/<name>.ts`.
 */
const INSTALLER_PATHS: Record<string, string> = {
  browser: '@/tools/browser/install',
  'browser-ext': '@/tools/browser-ext/install',
  docker: '@/tools/docker/install',
  mcp: '@/capabilities/installers/mcp',
  ollama: '@/capabilities/installers/ollama',
};

/**
 * Static capabilities not represented as BaseTool — services, side
 * processes, or external resources. Each has its own probe; the tool
 * registry doesn't know about them.
 */
const STATIC_PROBES: Record<string, () => Promise<{ available: boolean; reason?: string; version?: string; path?: string }>> = {
  mcp: async () => {
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const built = join(process.cwd(), 'mcp-server', 'dist', 'index.js');
    if (existsSync(built)) return { available: true, path: built };
    return { available: false, reason: 'mcp-server not built. Run `octi capabilities install mcp`.' };
  },
  ollama: async () => {
    const { probeOllama } = await import('@/setup/probes');
    const probe = await probeOllama();
    if (probe.ok) return { available: true, path: 'http://localhost:11434' };
    return { available: false, reason: probe.detail ?? 'unreachable' };
  },
};

async function loadInstaller(toolId: string): Promise<InstallerModule | null> {
  const path = INSTALLER_PATHS[toolId];
  if (!path) return null;
  try {
    const mod = (await import(path)) as { default?: InstallerModule } & InstallerModule;
    return (mod.default ?? mod) as InstallerModule;
  } catch (err) {
    logger.warn({ toolId, err }, 'capability installer not found');
    return null;
  }
}

class CapabilityService {
  private availableCache: { ids: Set<string>; loadedAt: number } | null = null;
  private static CACHE_TTL = 30_000; // 30s

  /**
   * Probe every registered tool, upsert results into the table.
   * Called at boot and after any install.
   */
  async probeAll(): Promise<CapabilityRow[]> {
    const registry = getToolRegistry();
    const toolProbes = await registry.checkAllAvailability();
    const db = getDb();
    const rows: CapabilityRow[] = [];

    const upsert = async (
      capId: string,
      probe: { available: boolean; degraded?: boolean; reason?: string | null; version?: string | null; path?: string | null },
    ) => {
      const installerKind = INSTALLER_PATHS[capId] ? 'bun-exec' : 'manual';
      const [row] = await db
        .insert(capabilities)
        .values({
          toolId: capId,
          available: probe.available,
          degraded: probe.degraded ?? false,
          reason: probe.reason ?? null,
          version: probe.version ?? null,
          path: probe.path ?? null,
          installerKind,
          checkedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: capabilities.toolId,
          set: {
            available: probe.available,
            degraded: probe.degraded ?? false,
            reason: probe.reason ?? null,
            version: probe.version ?? null,
            path: probe.path ?? null,
            checkedAt: new Date(),
            updatedAt: new Date(),
          },
        })
        .returning();
      rows.push(row);
    };

    for (const [toolId, probe] of toolProbes.entries()) {
      await upsert(toolId, probe);
    }
    for (const [capId, probeFn] of Object.entries(STATIC_PROBES)) {
      try {
        const probe = await probeFn();
        await upsert(capId, probe);
      } catch (err) {
        await upsert(capId, { available: false, reason: err instanceof Error ? err.message : String(err) });
      }
    }

    // Warm the in-memory cache so the orchestrator's synchronous gate
    // doesn't have to hit the DB on its first agent spawn.
    this.availableCache = {
      ids: new Set(rows.filter((r) => r.available).map((r) => r.toolId)),
      loadedAt: Date.now(),
    };
    logger.info({ count: rows.length, available: this.availableCache.ids.size }, 'capabilities probed');
    return rows;
  }

  /** Cached read — toolIds with `available=true`. */
  async getAvailable(): Promise<Set<string>> {
    if (this.availableCache && Date.now() - this.availableCache.loadedAt < CapabilityService.CACHE_TTL) {
      return this.availableCache.ids;
    }
    const db = getDb();
    const rows = await db.select({ toolId: capabilities.toolId }).from(capabilities).where(eq(capabilities.available, true));
    const ids = new Set(rows.map((r) => r.toolId));
    this.availableCache = { ids, loadedAt: Date.now() };
    return ids;
  }

  /**
   * Synchronous read of the in-memory cache. Returns null when the
   * cache hasn't been warmed yet — callers should treat null as
   * "don't gate" so we never block agent dispatch during boot.
   *
   * The cache is warmed by `probeAll()` at boot (src/index.ts) and
   * by `getAvailable()` on first async access.
   */
  getAvailableSync(): Set<string> | null {
    return this.availableCache?.ids ?? null;
  }

  /**
   * Re-probe a single capability and upsert its row + refresh the cache.
   * Used when a runtime config change flips a tool's availability without a
   * restart — e.g. configuring Twilio credentials makes the `voice` tool
   * available, and the role gate (`getToolsForRole`) reads this table. Without
   * this, the tool stayed gated out until the next boot-time `probeAll()`.
   */
  async reprobe(toolId: string): Promise<CapabilityRow | null> {
    let probe: { available: boolean; degraded?: boolean; reason?: string | null; version?: string | null; path?: string | null };
    try {
      const staticProbe = STATIC_PROBES[toolId];
      if (staticProbe) {
        probe = await staticProbe();
      } else {
        const registry = getToolRegistry();
        registry.invalidateAvailabilityCache();
        const p = await registry.checkAvailability(toolId);
        probe = { available: p.available, degraded: p.degraded, reason: p.reason };
      }
    } catch (err) {
      probe = { available: false, reason: err instanceof Error ? err.message : String(err) };
    }

    const db = getDb();
    const [row] = await db
      .insert(capabilities)
      .values({
        toolId,
        available: probe.available,
        degraded: probe.degraded ?? false,
        reason: probe.reason ?? null,
        version: probe.version ?? null,
        path: probe.path ?? null,
        installerKind: INSTALLER_PATHS[toolId] ? 'bun-exec' : 'manual',
        checkedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: capabilities.toolId,
        set: {
          available: probe.available,
          degraded: probe.degraded ?? false,
          reason: probe.reason ?? null,
          version: probe.version ?? null,
          path: probe.path ?? null,
          checkedAt: new Date(),
          updatedAt: new Date(),
        },
      })
      .returning();

    // Rebuild the in-memory cache from the fresh table state. Nulling alone
    // would make the synchronous gate (`getAvailableSync`) return null —
    // "don't gate" — until someone re-warms it; re-warming here keeps the
    // gate accurate for the very next agent spawn.
    this.availableCache = null;
    await this.getAvailable();
    logger.info({ toolId, available: probe.available, reason: probe.reason ?? undefined }, 'capability re-probed');
    return row ?? null;
  }

  /** Read every row, used by `octi capabilities` and `GET /capabilities`. */
  async list(): Promise<CapabilityRow[]> {
    const db = getDb();
    return db.select().from(capabilities).orderBy(capabilities.toolId);
  }

  /** Read a single row. */
  async get(toolId: string): Promise<CapabilityRow | null> {
    const db = getDb();
    const [row] = await db.select().from(capabilities).where(eq(capabilities.toolId, toolId)).limit(1);
    return row ?? null;
  }

  /**
   * Run the installer for one capability, re-probe on success.
   * Returns the InstallResult; reads the fresh row via `get(toolId)`.
   */
  async install(capId: string): Promise<InstallResult> {
    const installer = await loadInstaller(capId);
    if (!installer) {
      return { ok: false, detail: `No installer registered for "${capId}". See docs.` };
    }
    logger.info({ capId, kind: installer.kind }, 'capability install: starting');
    const result = await installer.install();
    logger.info({ capId, ok: result.ok, detail: result.detail }, 'capability install: done');

    // Re-probe to refresh the row. Tool capabilities go through the
    // registry; static capabilities run their own STATIC_PROBES entry.
    let probe: { available: boolean; degraded?: boolean; reason?: string; path?: string };
    const staticProbe = STATIC_PROBES[capId];
    if (staticProbe) {
      probe = await staticProbe();
    } else {
      const registry = getToolRegistry();
      registry.invalidateAvailabilityCache();
      const p = await registry.checkAvailability(capId);
      probe = { available: p.available, degraded: p.degraded, reason: p.reason };
    }

    const db = getDb();
    const version = installer.version ? await installer.version() : null;
    await db
      .update(capabilities)
      .set({
        available: probe.available,
        degraded: probe.degraded ?? false,
        reason: probe.reason ?? null,
        version,
        path: probe.path ?? null,
        checkedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(capabilities.toolId, capId));
    this.availableCache = null;
    return result;
  }

  /** Install all currently-missing capabilities that have an installer. */
  async installAllMissing(): Promise<Record<string, InstallResult>> {
    const rows = await this.list();
    const missing = rows.filter((r) => !r.available && INSTALLER_PATHS[r.toolId]);
    const out: Record<string, InstallResult> = {};
    for (const row of missing) {
      out[row.toolId] = await this.install(row.toolId);
    }
    return out;
  }
}

let _service: CapabilityService | null = null;

export function getCapabilityService(): CapabilityService {
  if (!_service) _service = new CapabilityService();
  return _service;
}
