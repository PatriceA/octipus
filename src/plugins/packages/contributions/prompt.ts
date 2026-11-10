/**
 * Prompt sections of plugin packages (docs/PLUGIN-PACKAGES.md#prompt-sections):
 * a static markdown file of the package, added to the system prompt of the
 * roles it names (every role when it names none) while the package is
 * enabled.
 *
 * Read only from files that still hash to the approved content, so what the
 * agents read is what the admin approved. The text depends on nothing but
 * the installed packages, the same bytes for every user: the root runner puts
 * it in the install tier (C3, docs/DIRECT-PROVIDERS.md), after the role
 * prompt and the delegation text, ordered by package name.
 */
import { open, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { PluginPromptDecl } from '@/shared/plugin-package';

/** The most characters a prompt file may hold. */
export const MAX_PROMPT_CHARS = 8_000;

interface Section { pkg: string; text: string; roles: readonly string[] | null }
const sections = new Map<string, Section>();

/**
 * Read a package's prompt file from `dir`: inside the directory (no link out
 * of it), a regular file of at most `MAX_PROMPT_CHARS` characters of UTF-8.
 * Throws with the reason.
 */
export async function readPromptFile(dir: string, decl: Pick<PluginPromptDecl, 'file'>): Promise<string> {
  const root = await realpath(dir);
  let path: string;
  try {
    path = await realpath(join(dir, decl.file));
  } catch {
    throw new Error(`prompt: ${decl.file} is not in the package`);
  }
  if (!path.startsWith(root + sep)) throw new Error(`prompt: ${decl.file} leads outside the package`);
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`prompt: ${decl.file} is not a file`);
    // UTF-8 is at most 4 bytes a character: a larger file is over the limit whatever it holds.
    if (stat.size > MAX_PROMPT_CHARS * 4) throw new Error(`prompt: ${decl.file} is longer than ${MAX_PROMPT_CHARS} characters`);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await handle.readFile());
    if (text.length > MAX_PROMPT_CHARS) throw new Error(`prompt: ${decl.file} is longer than ${MAX_PROMPT_CHARS} characters`);
    if (text.trim().length === 0) throw new Error(`prompt: ${decl.file} is empty`);
    return text;
  } catch (err) {
    if (err instanceof TypeError) throw new Error(`prompt: ${decl.file} is not UTF-8 text`);
    throw err;
  } finally {
    await handle.close();
  }
}

/** Add `pkg`'s section; the disposer removes it. */
export function bindPrompt(pkg: string, text: string, roles: readonly string[] | undefined): () => void {
  const section: Section = { pkg, text: text.trim(), roles: roles ?? null };
  sections.set(pkg, section);
  return () => { if (sections.get(pkg) === section) sections.delete(pkg); };
}

/** How many characters `pkg`'s bound section has, or null. */
export function boundPromptChars(pkg: string): number | null {
  return sections.get(pkg)?.text.length ?? null;
}

/**
 * The sections for an agent of `role`, ordered by package name: each its own
 * paragraph, headed with the package name. The same for every user.
 */
export function pluginPromptSections(role: string): Array<{ label: string; text: string }> {
  return [...sections.values()]
    .filter((s) => s.roles === null || s.roles.includes(role))
    .sort((a, b) => (a.pkg < b.pkg ? -1 : a.pkg > b.pkg ? 1 : 0))
    .map((s) => ({ label: `plugin-prompt:${s.pkg}`, text: `\n\nPLUGIN ${s.pkg}:\n${s.text}` }));
}
