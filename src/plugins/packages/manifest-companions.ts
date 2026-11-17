/** Companion services are downloadable artifacts, never plugin lifecycle hooks. */
import { z } from 'zod';
import { isPlainRelativePath } from './manifest-ui-host';

const text = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]*$/, 'companion text must be plain single-line text');
const path = (suffix: string) => z.string().max(300).refine(isPlainRelativePath, 'companion file must be a plain package-relative path').refine(p => p.endsWith(suffix), 'companion file must end in ' + suffix);
export const companionSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  title: text(80),
  description: text(1000),
  optional: z.boolean(),
  runsOn: text(300),
  platforms: z.array(z.enum(['linux', 'macos', 'windows'])).min(1).max(3),
  requirements: z.array(text(300)).min(1).max(12),
  dataAccess: z.array(text(300)).min(1).max(12),
  privileges: text(500),
  installation: z.literal('manual'),
  bundle: path('.tar.gz'),
  guide: path('.md'),
}).strict();
export const companionsSchema = z.array(companionSchema).min(1).max(10).refine(
  items => new Set(items.map(x => x.id)).size === items.length, 'companion ids must be unique',
);
export const COMPANION_FIELDS = { companions: companionsSchema.optional() };
