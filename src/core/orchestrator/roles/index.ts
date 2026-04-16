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

import { readdirSync, statSync, readFileSync } from 'fs';
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

    let prompt: string;
    try {
      prompt = readFileSync(promptPath, 'utf-8');
    } catch (err) {
      throw new Error(`Failed to read prompt at ${promptPath}: ${(err as Error).message}`);
    }

    roles[meta.role] = {
      role: meta.role,
      toolIds: meta.toolIds,
      defaultTopic: meta.defaultTopic,
      systemPromptTemplate: prompt,
    };
  }

  cached = roles as Record<AgentRole, RoleConfig>;
  return cached;
}

export function reloadRoles(): Record<AgentRole, RoleConfig> {
  cached = null;
  return loadRoles();
}
