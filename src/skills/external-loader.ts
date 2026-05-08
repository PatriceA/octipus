import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { getConfig } from '@/config';
import type { Skill } from '@/db/schema/skills';
import { logger } from '@/utils/logger';
import { markdownToSkill } from './markdown';

/**
 * Filesystem skill discovery (agentskills.io spec).
 *
 * Two location styles per pi-mono / claude-code conventions:
 *
 * 1. **Flat dirs** — direct `*.md` files at root are individual skills:
 *    `~/.octipus/agent/skills/`, `.octipus/skills/`,
 *    `~/.pi/agent/skills/`, `.pi/skills/`,
 *    `~/.claude/skills/`
 *
 * 2. **Recursive dirs** — any subdirectory containing `SKILL.md` is a skill:
 *    all of the above, plus `~/.agents/skills/`, `.agents/skills/`,
 *    plus user-configured `skills.externalDirectories`.
 *
 * External skills are surfaced as system skills with synthetic IDs prefixed
 * `external:<location-key>:<rel-path>` so they cannot collide with DB rows.
 */

const ID_PREFIX = 'external:';
const MAX_BYTES = 256 * 1024;
const MAX_DEPTH = 8;

interface ScanLocation {
  /** Absolute filesystem path */
  path: string;
  /** Stable slug used in skill IDs */
  key: string;
  /** Whether root-level *.md files are treated as flat skills */
  flatRootMd: boolean;
}

function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') return join(homedir(), p.slice(1));
  return p;
}

function defaultLocations(cwd: string, home: string): ScanLocation[] {
  return [
    { key: 'octipus-user',  path: join(home, '.octipus', 'agent', 'skills'), flatRootMd: true },
    { key: 'octipus-project', path: join(cwd, '.octipus', 'skills'),         flatRootMd: true },
    { key: 'agents-user',   path: join(home, '.agents', 'skills'),           flatRootMd: false },
    { key: 'agents-project', path: join(cwd, '.agents', 'skills'),           flatRootMd: false },
    { key: 'pi-user',       path: join(home, '.pi', 'agent', 'skills'),      flatRootMd: true },
    { key: 'pi-project',    path: join(cwd, '.pi', 'skills'),                flatRootMd: true },
    { key: 'claude-user',   path: join(home, '.claude', 'skills'),           flatRootMd: true },
  ];
}

function configuredLocations(dirs: string[], home: string): ScanLocation[] {
  return dirs
    .filter(d => typeof d === 'string' && d.length > 0)
    .map((d, i) => ({
      key: `cfg-${i}`,
      path: resolve(expandHome(d).replace(/^~(?=$|[/\\])/, home)),
      flatRootMd: true,
    }));
}

function safeReadFile(path: string): string | undefined {
  try {
    const st = statSync(path);
    if (!st.isFile()) return undefined;
    if (st.size > MAX_BYTES) {
      logger.warn(`[skills/external] skipping oversize skill ${path} (${st.size} > ${MAX_BYTES})`);
      return undefined;
    }
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function isMd(name: string): boolean {
  return name.endsWith('.md') || name.endsWith('.MD');
}

interface FoundFile {
  filePath: string;
  relPath: string;
  /** True when discovered as flat root-md (not SKILL.md inside a dir) */
  flat: boolean;
}

function walk(root: string, flatRootMd: boolean): FoundFile[] {
  const out: FoundFile[] = [];
  if (!existsSync(root)) return out;

  function recurse(dir: string, depth: number, atRoot: boolean) {
    if (depth > MAX_DEPTH) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }

    for (const name of entries) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }

      if (st.isDirectory()) {
        // Skill directory — has SKILL.md (case-sensitive per spec, lenient fallback)
        const skillFile = ['SKILL.md', 'Skill.md', 'skill.md']
          .map(f => join(full, f))
          .find(p => existsSync(p));
        if (skillFile) {
          out.push({ filePath: skillFile, relPath: relative(root, skillFile), flat: false });
          // do not descend into a skill dir
        } else {
          recurse(full, depth + 1, false);
        }
      } else if (st.isFile() && atRoot && flatRootMd && isMd(name)) {
        out.push({ filePath: full, relPath: relative(root, full), flat: true });
      }
    }
  }

  recurse(root, 0, true);
  return out;
}

function hasFrontmatterField(md: string, field: string): boolean {
  // Look only inside the first --- ... --- block.
  const trimmed = md.trim();
  if (!trimmed.startsWith('---')) return false;
  const end = trimmed.indexOf('\n---', 3);
  if (end === -1) return false;
  const fm = trimmed.slice(3, end);
  const re = new RegExp(`^\\s*${field}\\s*:\\s*\\S`, 'm');
  return re.test(fm);
}

function toSkill(loc: ScanLocation, found: FoundFile): Skill | undefined {
  const md = safeReadFile(found.filePath);
  if (!md) return undefined;

  // Required fields per agentskills.io spec — must be present in frontmatter,
  // not defaulted by the parser.
  if (!hasFrontmatterField(md, 'name') || !hasFrontmatterField(md, 'description')) {
    logger.warn(`[skills/external] ${found.filePath}: missing name/description in frontmatter, skipping`);
    return undefined;
  }

  const portable = markdownToSkill(md);

  // Synthetic id: external:<loc-key>:<rel-path-without-extension>
  const slug = found.relPath.replace(/\.(md|MD)$/, '').replace(/[/\\]/g, ':');
  const id = `${ID_PREFIX}${loc.key}:${slug}`;
  const now = new Date();

  return {
    id,
    name: portable.name,
    category: portable.category ?? 'general',
    description: portable.description,
    content: portable.content ?? '',
    principles: portable.principles ?? [],
    bestPractices: portable.bestPractices ?? [],
    antiPatterns: portable.antiPatterns ?? [],
    frameworks: portable.frameworks ?? [],
    isSystem: true,
    userId: null,
    orgId: null,
    triggers: [],
    descriptionEmbedding: null,
    descriptionHash: null,
    alwaysInject: false,
    createdAt: now,
    updatedAt: now,
  } satisfies Skill;
}

export interface LoadExternalSkillsOptions {
  /** Project root for `.octipus/skills`, `.pi/skills`, `.agents/skills`. Default `process.cwd()`. */
  cwd?: string;
  /** Home dir for `~/.octipus/agent/skills` etc. Default `os.homedir()`. */
  home?: string;
  /** Extra directories from settings. Default reads `getConfig().skills.externalDirectories`. */
  configuredDirs?: string[];
  /** Force-disable discovery (overrides config). */
  enabled?: boolean;
}

/**
 * Scan all configured + default locations and return the parsed skills.
 * Pure (no caching) — caller is responsible for caching the result.
 */
export function loadExternalSkills(opts: LoadExternalSkillsOptions = {}): Skill[] {
  let cfgEnabled = true;
  let cfgDirs: string[] = [];
  try {
    const cfg = getConfig().skills;
    cfgEnabled = cfg?.externalEnabled !== false;
    cfgDirs = cfg?.externalDirectories ?? [];
  } catch {
    // Config not loaded yet (early startup or test) — proceed with defaults
  }

  const enabled = opts.enabled ?? cfgEnabled;
  if (!enabled) return [];

  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  const dirs = opts.configuredDirs ?? cfgDirs;

  const locations = [...defaultLocations(cwd, home), ...configuredLocations(dirs, home)];
  const seen = new Set<string>();
  const out: Skill[] = [];

  for (const loc of locations) {
    const files = walk(loc.path, loc.flatRootMd);
    for (const f of files) {
      const skill = toSkill(loc, f);
      if (!skill) continue;
      if (seen.has(skill.id)) continue;
      seen.add(skill.id);
      out.push(skill);
    }
  }

  return out;
}

export function isExternalSkillId(id: string): boolean {
  return id.startsWith(ID_PREFIX);
}
