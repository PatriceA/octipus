/**
 * The manifest fields for pages (`ui`) and the host API (`host`),
 * docs/PLUGIN-PACKAGES.md#pages and #host-api. Kept apart from ./manifest.ts,
 * which spreads `UI_HOST_FIELDS` into its schema.
 *
 * A page's files are served from one directory of the package (`ui.dir`,
 * default `ui`), so its paths are checked here as plain relative paths:
 * no `..`, no absolute path, no backslash, no hidden segment. The tree check
 * at install already refuses symbolic links anywhere in the package.
 */
import { z } from 'zod';
import { PLUGIN_HOST_SCOPES } from '@/shared/plugin-package';

/** A page path under `/plugins/<name>/`: lower-case segments joined by `/`. */
const PAGE_PATH_RE = /^[a-z0-9][a-z0-9-]{0,39}(\/[a-z0-9][a-z0-9-]{0,39}){0,3}$/;
/** A lucide icon name such as `chart-bar`. */
const ICON_RE = /^[a-z][a-z0-9-]{0,39}$/;
/** One segment of a relative file path: letters, digits, `._-`, not starting with a dot. */
const SEGMENT_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/;

/** Whether `p` is a plain relative path (`a/b.html`): no `..`, `.`, empty or hidden segment, no backslash. */
export function isPlainRelativePath(p: string): boolean {
  if (p.length === 0 || p.length > 300 || p.includes('\\') || p.startsWith('/')) return false;
  return p.split('/').every((segment) => SEGMENT_RE.test(segment) && segment !== '.' && segment !== '..');
}

const relativePath = (field: string) => z.string().refine(isPlainRelativePath, `${field}: a relative path such as ui/index.html (no "..", no hidden or absolute path)`);

export const uiSchema = z.object({
  dir: relativePath('ui.dir').optional(),
  pages: z.array(z.object({
    path: z.string().regex(PAGE_PATH_RE, 'ui.pages: a path is lower-case letters, digits and - in up to four /-separated segments'),
    title: z.string().trim().min(1).max(60),
    icon: z.string().regex(ICON_RE, 'ui.pages: an icon is a lucide icon name such as chart-bar').optional(),
    entry: relativePath('ui.pages.entry').refine((e) => /\.html?$/i.test(e), 'ui.pages: an entry is an .html file'),
  }).strict()).min(1, 'ui.pages: declare at least one page').max(20, 'ui.pages: at most 20'),
}).strict().superRefine((ui, ctx) => {
  const seen = new Set<string>();
  for (const page of ui.pages) {
    if (seen.has(page.path)) ctx.addIssue({ code: 'custom', message: `ui.pages: "${page.path}" is declared twice` });
    seen.add(page.path);
  }
});

export const hostSchema = z.array(z.enum(PLUGIN_HOST_SCOPES, {
  error: () => `host: a scope is one of ${PLUGIN_HOST_SCOPES.join(', ')}`,
})).max(PLUGIN_HOST_SCOPES.length).refine((scopes) => new Set(scopes).size === scopes.length, 'host: a scope is declared twice');

/** Spread into the manifest's object schema. */
export const UI_HOST_FIELDS = {
  ui: uiSchema.optional(),
  host: hostSchema.optional(),
};

/** The served UI directory of a manifest, relative to the package root. */
export function uiDirOf(ui: { dir?: string } | undefined): string {
  return ui?.dir ?? 'ui';
}
