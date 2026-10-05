import { existsSync, readdirSync, statSync } from 'fs';
import { resolve } from 'path';
import { getConfig } from '@/config';
import type { WorkspaceFS } from '@/security/workspace-fs';
import { fileAt } from '@/utils/fs-file';

/**
 * AGENTS.md — the universal, curated project guide (https://agents.md).
 *
 * Each repository carries an `AGENTS.md` at its root describing structure,
 * stack, key files, and commands. Octipus reads it as durable project context
 * and the same file is honoured by other agent tools (Codex, Cursor, Mistral
 * Vibe, …), so a single curated guide serves every agent that touches the repo.
 *
 * This replaces the old auto-appended `.octipus/project-summary.md` log. The
 * curated model is read-mostly: agents READ the guide as context and UPDATE it
 * deliberately when they learn something structurally important — they do NOT
 * dump raw run output into it (run history lives in trajectories/work-stream).
 */

export const AGENTS_MD_FILENAME = 'AGENTS.md';

/** Curated guides are meant to be concise; cap what we inject to bound tokens. */
const MAX_AGENTS_MD_CHARS = 8000;

/** Absolute path to a repo's AGENTS.md. */
export function agentsMdPath(repoRoot: string): string {
  return resolve(repoRoot, AGENTS_MD_FILENAME);
}

/**
 * Load a repository's curated AGENTS.md guide.
 *
 * @param repoRoot Repository root to read from. Falls back to the configured
 *   workspace root when omitted.
 * @returns The guide text (capped to {@link MAX_AGENTS_MD_CHARS}) or `null` when
 *   the repo has no AGENTS.md.
 */
export async function loadAgentsMd(repoRoot?: string): Promise<string | null> {
  try {
    const root = repoRoot || getConfig().workspace?.rootPath || '.';
    const file = fileAt(agentsMdPath(root));
    if (await file.exists()) {
      const content = await file.text();
      return content.slice(0, MAX_AGENTS_MD_CHARS);
    }
  } catch {
    // No AGENTS.md or not readable — treated as "no curated guide".
  }
  return null;
}

/** Synchronous existence check, used to annotate repo listings. */
export function hasAgentsMd(repoRoot: string): boolean {
  try {
    const { existsSync } = require('fs') as typeof import('fs');
    return existsSync(agentsMdPath(repoRoot));
  } catch {
    return false;
  }
}

/**
 * The project folders of a workspace root, as the root agent's prompt lists
 * them (`  - name/`, flagged when they carry an AGENTS.md): the root's
 * non-hidden directories, or for a guest's root in a space (S6) the folders
 * of their scope only — never the names of the rest of the space.
 */
export function projectListing(fs: WorkspaceFS): string[] {
  const entries = fs.guestFolders
    ? fs.guestFolders
      .map(name => ({ name, path: fs.resolveOptional(name) }))
      .filter((e): e is { name: string; path: string } => !!e.path && existsSync(e.path) && statSync(e.path).isDirectory())
    : readdirSync(fs.root)
      .filter(name => !name.startsWith('.') && statSync(resolve(fs.root, name)).isDirectory())
      .map(name => ({ name, path: resolve(fs.root, name) }));
  return entries.map(({ name, path }) => (hasAgentsMd(path) ? `  - ${name}/ (has AGENTS.md)` : `  - ${name}/`));
}
