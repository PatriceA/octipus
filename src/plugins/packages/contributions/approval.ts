/**
 * The contributions hash (docs/PLUGIN-PACKAGES.md#approving-contributions):
 * what an admin approves before a package's commands, schedules, events,
 * prompt section, context and agent roles bind. `sha256:<hex>` over the
 * canonical JSON of the manifest's contribution fields, a newline, and the
 * prompt file's bytes; then, for a package that adds roles, each role's
 * prompt file as a newline, its byte length in decimal, a newline and its
 * bytes, in declared order — length-prefixed, so no two different splits of
 * the same bytes hash alike. Nothing more for a package that adds none, so an
 * approval made before roles existed still matches.
 * Anything that changes what the package adds to every user's agents changes
 * it, so a changed package must be approved again.
 */
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { PluginManifest } from '@/shared/plugin-package';
import { MAX_PROMPT_CHARS, readPromptFile } from './prompt';

/** The fields the hash covers, in this order. */
const FIELDS = ['commands', 'schedules', 'events', 'prompt', 'context', 'roles'] as const;

/** JSON with object keys sorted at every level and `undefined` members left out. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** Whether the manifest declares any contribution besides tools. */
export function hasContributions(m: Pick<PluginManifest, (typeof FIELDS)[number]>): boolean {
  return !!(m.commands?.length || m.schedules?.length || m.events?.length || m.prompt || m.context || m.roles?.length);
}

/** The contribution fields of a manifest, as hashed. */
export function contributionFields(m: PluginManifest): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of FIELDS) {
    const v = m[f];
    if (v !== undefined && !(Array.isArray(v) && v.length === 0)) out[f] = v;
  }
  return out;
}

/** The hash of the fields, the prompt file's bytes (empty when there is none) and each role prompt's bytes. */
export function hashContributions(m: PluginManifest, promptBytes: Uint8Array | null, rolePromptBytes: readonly Uint8Array[] = []): string {
  const h = createHash('sha256');
  h.update(canonicalJson(contributionFields(m)));
  h.update('\n');
  if (promptBytes) h.update(promptBytes);
  for (const bytes of rolePromptBytes) {
    h.update(`\n${bytes.byteLength}\n`);
    h.update(bytes);
  }
  return `sha256:${h.digest('hex')}`;
}

/**
 * The contributions hash of the package in `dir` and its prompt text, both
 * from one read of the prompt file (so the text bound is the text hashed).
 * Null hash when it declares none. Throws when its prompt file cannot be
 * read (as at install).
 */
export async function readContributions(
  m: PluginManifest, dir: string,
): Promise<{ hash: string | null; promptText: string | null; rolePrompts: Map<string, string> }> {
  const rolePrompts = new Map<string, string>();
  if (!hasContributions(m)) return { hash: null, promptText: null, rolePrompts };
  let bytes: Uint8Array | null = null;
  let promptText: string | null = null;
  if (m.prompt) {
    // Checked as at install (inside the package, a size cap, UTF-8), then read once as bytes.
    await readPromptFile(dir, m.prompt);
    bytes = await readFile(await realpath(join(dir, m.prompt.file)));
    promptText = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (promptText.length > MAX_PROMPT_CHARS) throw new Error(`prompt: ${m.prompt.file} is longer than ${MAX_PROMPT_CHARS} characters`);
  }
  // Each role's prompt the same way: checked, read once, and the text bound is
  // the text hashed.
  const roleBytes: Uint8Array[] = [];
  for (const role of m.roles ?? []) {
    await readPromptFile(dir, { file: role.prompt });
    const raw = await readFile(await realpath(join(dir, role.prompt)));
    const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    if (text.length > MAX_PROMPT_CHARS) throw new Error(`roles.${role.id}: ${role.prompt} is longer than ${MAX_PROMPT_CHARS} characters`);
    roleBytes.push(raw);
    rolePrompts.set(role.id, text);
  }
  return { hash: hashContributions(m, bytes, roleBytes), promptText, rolePrompts };
}

/** The contributions hash of the package in `dir`, or null when it declares none. */
export async function contributionsHashOf(m: PluginManifest, dir: string): Promise<string | null> {
  return (await readContributions(m, dir)).hash;
}
