/**
 * The skill registry index (docs/SKILL-EXCHANGE.md#the-index): a static JSON
 * document listing signed skill bundles, parsed here as hostile input and
 * built here from a directory of bundles (`octi plugin build-skill-index`).
 *
 * Pure (no config, no database, no network), so the offline CLI and the host
 * read and write exactly one format.
 *
 * - **Size.** At most `MAX_SKILL_INDEX_BYTES`, `MAX_SKILL_INDEX_ENTRIES`
 *   entries, and a length limit on every string and list.
 * - **Text.** No control, bidirectional or invisible characters. Descriptions
 *   are plain text, shown as text.
 * - **URLs.** A bundle URL is https, without credentials or a fragment, and
 *   never names localhost or a private, loopback, link-local or ambiguous IP
 *   literal. A host name is checked again when it is fetched (the SSRF guard
 *   resolves it and refuses private addresses, redirects included).
 * - **Entries.** One that does not fit is skipped and reported, so it can
 *   never be installed; a name and version listed twice are both skipped.
 * - **Trust.** Nothing in an index is trusted: the digest pins the bytes, and
 *   the bundle's own signature, checked against the operator's keys, says who
 *   published it. `publisherKeyId`, `skills` and `contentHash` are claims the
 *   install checks against the bundle.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { line } from '@/plugins/packages/listing-text';
import { isKeyId } from '@/plugins/packages/signature';
import {
  SKILL_INDEX_FORMAT,
  SKILL_INDEX_VERSION,
  type SkillIndex,
  type SkillIndexEntry,
} from '@/shared/skill-registry';
import { isIpLiteral, isPrivateIP, looksLikeNonStandardIpLiteral } from '@/utils/sanitize';
import { MAX_BUNDLE_SKILLS, MAX_SKILL_NAME_CHARS, parseSkillBundle } from './exchange';

/** The largest index read, in bytes. */
export const MAX_SKILL_INDEX_BYTES = 1024 * 1024;
/** The most entries one index lists. */
export const MAX_SKILL_INDEX_ENTRIES = 2000;
const MAX_DESCRIPTION_CHARS = 1000;
const MAX_TAGS = 10;
const MAX_TAG_CHARS = 32;
const MAX_URL_CHARS = 2000;

export class SkillIndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillIndexError';
  }
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const SEMVER_RE = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,64})?$/;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * Why `url` cannot be a bundle URL, or null when it can: https, no
 * credentials, no fragment, and no host that is localhost or a private,
 * reserved or ambiguous IP literal.
 */
export function bundleUrlProblem(url: string): string | null {
  if (url.length > MAX_URL_CHARS) return `longer than ${MAX_URL_CHARS} characters`;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'not a URL';
  }
  if (parsed.protocol !== 'https:') return `only https is fetched (${parsed.protocol} refused)`;
  if (parsed.username || parsed.password) return 'a URL with credentials in it is refused';
  if (parsed.hash !== '' || url.includes('#')) return 'a URL with a fragment (#…) is refused';
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return 'localhost is refused';
  if (looksLikeNonStandardIpLiteral(host)) return `an ambiguous IP literal (${host}) is refused`;
  if (isIpLiteral(host) && isPrivateIP(host)) return `a private or reserved address (${host}) is refused`;
  return null;
}

const entrySchema = z.strictObject({
  name: z.string().regex(NAME_RE, 'lower-case letters, digits, ".", "_" and "-", at most 100, starting with a letter or digit'),
  version: z.string().regex(SEMVER_RE, 'a semantic version such as 1.2.0'),
  description: line(MAX_DESCRIPTION_CHARS).refine((s) => s.trim().length > 0, 'must not be blank'),
  tags: z.array(line(MAX_TAG_CHARS).refine((s) => s.trim().length > 0, 'must not be blank')).max(MAX_TAGS).default([]),
  author: line(100).nullable().default(null),
  publisherKeyId: z.string().refine(isKeyId, 'a key id, ed25519:<64 hex>').nullable(),
  skills: z.array(line(MAX_SKILL_NAME_CHARS).refine((s) => s.trim().length > 0, 'must not be blank')).min(1).max(MAX_BUNDLE_SKILLS),
  bundleUrl: z.string().max(MAX_URL_CHARS).superRefine((url, ctx) => {
    const problem = bundleUrlProblem(url);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  }),
  bundleSha256: z.string().regex(SHA256_RE, 'sha256:<64 lowercase hex>'),
  contentHash: z.string().regex(SHA256_RE, 'sha256:<64 lowercase hex>'),
});

const documentSchema = z.strictObject({
  format: z.literal(SKILL_INDEX_FORMAT, { error: `not a skill index: format must be "${SKILL_INDEX_FORMAT}"` }),
  version: z.number().superRefine((v, ctx) => {
    if (v === SKILL_INDEX_VERSION) return;
    ctx.addIssue({ code: 'custom', message: v > SKILL_INDEX_VERSION
      ? `index version ${v} is newer than this Octipus reads (${SKILL_INDEX_VERSION}); upgrade Octipus to browse it`
      : `unsupported index version ${v}` });
  }),
  generatedAt: z.string().max(40).refine((s) => !Number.isNaN(Date.parse(s)), 'an ISO date-time').nullable().default(null),
  // Each entry is checked on its own below, so one bad entry does not hide the rest.
  entries: z.array(z.unknown()).max(MAX_SKILL_INDEX_ENTRIES, `at most ${MAX_SKILL_INDEX_ENTRIES} entries`),
});

function describe(error: z.ZodError): string {
  return error.issues.slice(0, 3).map((issue) => `${issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''}${issue.message}`).join('; ');
}

/** An index as read: the usable entries, and what is wrong with the others. */
export interface ParsedSkillIndex {
  generatedAt: string | null;
  entries: SkillIndexEntry[];
  problems: string[];
}

/**
 * Read an index's bytes: size, JSON, the document schema (all or nothing),
 * then each entry on its own (skipped and reported when it does not fit).
 * Throws `SkillIndexError` when the document itself is refused.
 */
export function parseSkillIndex(bytes: Uint8Array): ParsedSkillIndex {
  if (bytes.byteLength > MAX_SKILL_INDEX_BYTES) throw new SkillIndexError(`The index is ${bytes.byteLength} bytes; at most ${MAX_SKILL_INDEX_BYTES} are read`);
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new SkillIndexError('The index is not valid JSON');
  }
  const doc = documentSchema.safeParse(json);
  if (!doc.success) throw new SkillIndexError(`Not a valid skill index: ${describe(doc.error)}`);
  const problems: string[] = [];
  const parsed: SkillIndexEntry[] = [];
  doc.data.entries.forEach((raw, i) => {
    const result = entrySchema.safeParse(raw);
    if (!result.success) {
      const name = typeof raw === 'object' && raw !== null && typeof (raw as { name?: unknown }).name === 'string' && NAME_RE.test((raw as { name: string }).name)
        ? ` (${(raw as { name: string }).name})` : '';
      problems.push(`entries[${i}]${name}: ${describe(result.error)}`);
      return;
    }
    const lower = result.data.skills.map((s) => s.trim().toLowerCase());
    if (new Set(lower).size !== lower.length) {
      problems.push(`entries[${i}] (${result.data.name}): a skill name is listed twice`);
      return;
    }
    parsed.push(result.data);
  });
  const counts = new Map<string, number>();
  for (const e of parsed) counts.set(`${e.name}@${e.version}`, (counts.get(`${e.name}@${e.version}`) ?? 0) + 1);
  const entries = parsed.filter((e) => {
    if ((counts.get(`${e.name}@${e.version}`) ?? 0) === 1) return true;
    problems.push(`${e.name} ${e.version}: listed more than once; neither is listed`);
    return false;
  });
  return { generatedAt: doc.data.generatedAt, entries, problems: [...new Set(problems)] };
}

/** The listing metadata of one bundle, beside it as `<bundle>.listing.json`. */
const listingFileSchema = z.strictObject({
  name: entrySchema.shape.name,
  version: entrySchema.shape.version,
  description: entrySchema.shape.description.optional(),
  tags: entrySchema.shape.tags,
  author: entrySchema.shape.author,
});

/** One bundle file to index: its exact bytes, its listing metadata (JSON text), and the URL it will be served at. */
export interface IndexInput {
  file: string;
  bytes: Uint8Array;
  listing: string;
  bundleUrl: string;
}

/**
 * Build an index from bundle files and their listing metadata. Each bundle is
 * checked as an import checks it (schema, content hash); its digest, content
 * hash, skill names and signing key id are read from it, never from the
 * listing. Throws `SkillIndexError` naming the file on the first problem.
 */
export function buildSkillIndex(inputs: readonly IndexInput[], generatedAt = new Date()): SkillIndex {
  if (inputs.length > MAX_SKILL_INDEX_ENTRIES) throw new SkillIndexError(`At most ${MAX_SKILL_INDEX_ENTRIES} bundles are indexed; ${inputs.length} given`);
  const entries = inputs.map((input): SkillIndexEntry => {
    let bundle: ReturnType<typeof parseSkillBundle>;
    try {
      bundle = parseSkillBundle(Buffer.from(input.bytes).toString('utf8'));
    } catch (err) {
      throw new SkillIndexError(`${input.file}: ${(err as Error).message}`);
    }
    let listingJson: unknown;
    try {
      listingJson = JSON.parse(input.listing);
    } catch {
      throw new SkillIndexError(`${input.file}: its listing file is not valid JSON`);
    }
    const listing = listingFileSchema.safeParse(listingJson);
    if (!listing.success) throw new SkillIndexError(`${input.file}: its listing file is not valid: ${describe(listing.error)}`);
    const description = listing.data.description ?? (bundle.skills.length === 1 ? bundle.skills[0].description.replace(/\s+/g, ' ').trim().slice(0, MAX_DESCRIPTION_CHARS) : undefined);
    if (description === undefined) throw new SkillIndexError(`${input.file}: a bundle of several skills needs a "description" in its listing file`);
    const entry: SkillIndexEntry = {
      name: listing.data.name,
      version: listing.data.version,
      description,
      tags: listing.data.tags,
      author: listing.data.author,
      publisherKeyId: bundle.signature?.keyId ?? null,
      skills: bundle.skills.map((s) => s.name),
      bundleUrl: input.bundleUrl,
      bundleSha256: `sha256:${createHash('sha256').update(input.bytes).digest('hex')}`,
      contentHash: bundle.contentHash,
    };
    const checked = entrySchema.safeParse(entry);
    if (!checked.success) throw new SkillIndexError(`${input.file}: ${describe(checked.error)}`);
    return checked.data;
  });
  const seen = new Set<string>();
  for (const e of entries) {
    const key = `${e.name}@${e.version}`;
    if (seen.has(key)) throw new SkillIndexError(`${e.name} ${e.version} is listed by two bundles; give each version its own`);
    seen.add(key);
  }
  entries.sort((a, b) => (a.name === b.name ? (a.version < b.version ? -1 : 1) : a.name < b.name ? -1 : 1));
  return { format: SKILL_INDEX_FORMAT, version: SKILL_INDEX_VERSION, generatedAt: generatedAt.toISOString(), entries };
}
