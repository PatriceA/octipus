/**
 * Role registry — auto-loads role folders from `roles/<name>/`.
 *
 * Each role is a folder containing:
 *   - `config.ts`  — exports `meta: RoleMeta` (role, toolIds, defaultTopic)
 *   - `prompt.md`  — system prompt template
 *
 * Adding a new role is two files in one folder. The registry picks it up
 * at startup and validates that the folder name matches `meta.role`.
 *
 * Inspired by the catalog pattern in https://github.com/WeaveMindAI/weft.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { AgentRole, RoleConfig } from '../types';
import type { RoleMeta } from './types';

const HERE = dirname(fileURLToPath(import.meta.url));

let cached: Record<AgentRole, RoleConfig> | null = null;

/**
 * Discover and load every role folder. Synchronous so callers (orchestrator,
 * worker spawner) can use the registry without awaiting.
 *
 * Caches after first call. Use `reloadRoles()` to force a re-read.
 */
export function loadRoles(): Record<AgentRole, RoleConfig> {
  if (cached) return cached;

  const roles: Partial<Record<AgentRole, RoleConfig>> = {};
  const entries = readdirSync(HERE);

  for (const name of entries) {
    const dir = resolve(HERE, name);
    let stats;
    try {
      stats = statSync(dir);
    } catch {
      continue;
    }
    if (!stats.isDirectory()) continue;

    const configPath = resolve(dir, 'config.ts');
    const promptPath = resolve(dir, 'prompt.md');

    let meta: RoleMeta;
    try {
      // Synchronous require via Bun's runtime — works because the registry
      // loads at startup, before any role is actually used.
      const mod = require(configPath) as { meta: RoleMeta };
      meta = mod.meta;
    } catch (err) {
      throw new Error(`Failed to load role config at ${configPath}: ${(err as Error).message}`);
    }

    if (meta.role !== name) {
      throw new Error(
        `Role folder '${name}' contains config with role '${meta.role}' — folder name must match.`,
      );
    }

    // Invariant: coreToolIds ⊆ toolIds. Fail loud at load — a typo here would
    // silently advertise nothing for that id and force a wasted discovery
    // round-trip on the common path.
    if (meta.coreToolIds) {
      const unknown = meta.coreToolIds.filter((id) => !meta.toolIds.includes(id));
      if (unknown.length > 0) {
        throw new Error(
          `Role '${name}' coreToolIds [${unknown.join(', ')}] not present in toolIds — must be a subset.`,
        );
      }
    }

    let prompt: string;
    try {
      prompt = readFileSync(promptPath, 'utf-8');
    } catch (err) {
      throw new Error(`Failed to read prompt at ${promptPath}: ${(err as Error).message}`);
    }

    // Optional dense small-model variant (Phase C). Absent for roles that
    // haven't been given one yet — those keep using the full prompt. A missing
    // file is fine (ENOENT → undefined); any OTHER read error (bad perms,
    // decode) throws like the full-prompt read, so a broken lite variant is
    // never silently ignored. A blank/whitespace-only file is treated as absent
    // so it can't replace the role prompt with a bare preamble.
    let litePrompt: string | undefined;
    try {
      const raw = readFileSync(resolve(dir, 'prompt.lite.md'), 'utf-8');
      litePrompt = raw.trim() ? raw : undefined;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Failed to read lite prompt at ${resolve(dir, 'prompt.lite.md')}: ${(err as Error).message}`);
      }
      litePrompt = undefined;
    }

    roles[meta.role] = {
      role: meta.role,
      toolIds: meta.toolIds,
      defaultTopic: meta.defaultTopic,
      systemPromptTemplate: prompt,
      liteSystemPromptTemplate: litePrompt,
      coreToolIds: meta.coreToolIds,
    };
  }

  cached = roles as Record<AgentRole, RoleConfig>;
  return cached;
}

export function reloadRoles(): Record<AgentRole, RoleConfig> {
  cached = null;
  return loadRoles();
}
