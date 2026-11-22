/**
 * Skill exchange bundles (docs/SKILL-EXCHANGE.md): skills exported as one
 * versioned JSON file and imported back, here or on another Octipus.
 *
 *   { "format": "octipus-skill-bundle", "version": 1,
 *     "skills": [{ name, category, description, content, principles,
 *                  bestPractices, antiPatterns, frameworks }],
 *     "contentHash": "sha256:<hex>",
 *     "signature": null | { "alg": "ed25519", "keyId": "ed25519:<hex>", "signature": "<base64>" } }
 *
 * The content hash is the sha256 of the canonical form of `format`,
 * `version` and `skills` (`bundleContentHash`). The signature is the plugin
 * package signature (src/plugins/packages/signature.ts) over that hash under
 * its own domain prefix, made with a plugin publisher key, and checked
 * against the same `plugins.trustedPublishers`, `plugins.revokedKeys` and
 * `plugins.requireSignature` as a plugin package (`checkBundleTrust`).
 *
 * A bundle carries only what recreates a skill. Ids, owners, organizations,
 * trust flags (`isSystem`, `alwaysInject`), discovery triggers, tool grants,
 * usage counters and embeddings are never exported, and a bundle that names
 * any of them is refused: the schema is strict. What a valid signature says:
 * the holder of that key published this exact content. Not that it is safe —
 * an imported skill is prompt text that steers agents, so the import shows it
 * in full before anything is written (./exchange-import.ts).
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getConfig } from '@/config';
import type { SkillView } from '@/db/schema/skills';
import {
  isKeyId,
  type SignatureCheck,
  type SignatureFile,
  type SigningKey,
  signSkillBundle,
  trustedKeys,
  verifySkillBundle,
} from '@/plugins/packages/signature';
import {
  type BundleSignatureView,
  type BundleSkill,
  SKILL_BUNDLE_FORMAT,
  SKILL_BUNDLE_VERSION,
  type SkillBundle,
} from '@/shared/skill-exchange';
import { coreLogger } from '@/utils/logger';
import { parseSkillMd } from './external-loader';

/** The largest bundle (or SKILL.md) read, in bytes, from an upload, a paste or a URL. */
export const MAX_BUNDLE_BYTES = 1024 * 1024;
/** The most skills one bundle carries. */
export const MAX_BUNDLE_SKILLS = 50;
/** The longest skill body, as a mounted SKILL.md (src/skills/external-loader.ts). */
export const MAX_SKILL_CONTENT_CHARS = 256 * 1024;
export const MAX_SKILL_NAME_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 2000;
const MAX_CATEGORY_CHARS = 64;
const MAX_LIST_ITEMS = 100;
const MAX_LIST_ITEM_CHARS = 2000;

/** The fields a bundle skill has, in the canonical order the content hash is computed in. */
export const BUNDLE_SKILL_FIELDS = ['name', 'category', 'description', 'content', 'principles', 'bestPractices', 'antiPatterns', 'frameworks'] as const;

export class SkillBundleError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 = 400) {
    super(message);
    this.name = 'SkillBundleError';
  }
}

const NO_CONTROL = /^[^\u0000-\u001f\u007f]*$/;
/**
 * Text may hold tabs and line breaks, and no other C0 control character or
 * DEL: they have no place in prompt text, and Postgres refuses NUL in text
 * and jsonb, so letting one through only moved the refusal to a 500 at install.
 */
const TEXT_CONTROL = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/;
const TEXT_CONTROL_MESSAGE = 'must not contain control characters other than tab and line breaks';
const nonBlank = (s: string) => s.trim().length > 0;
const text = (max: number) => z.string().max(max).refine((s) => TEXT_CONTROL.test(s), TEXT_CONTROL_MESSAGE);
const list = z.array(text(MAX_LIST_ITEM_CHARS)).max(MAX_LIST_ITEMS);

/** A skill name as the import accepts one (a bundle's, or a rename). */
export const skillNameSchema = z.string().min(1).max(MAX_SKILL_NAME_CHARS)
  .refine(nonBlank, 'must not be blank').refine((s) => NO_CONTROL.test(s), 'must be one line without control characters');

const bundleSkillSchema = z.strictObject({
  name: skillNameSchema,
  category: z.string().min(1).max(MAX_CATEGORY_CHARS).refine(nonBlank, 'must not be blank').refine((s) => NO_CONTROL.test(s), 'must be one line without control characters'),
  description: text(MAX_DESCRIPTION_CHARS).refine(nonBlank, 'must not be blank'),
  content: text(MAX_SKILL_CONTENT_CHARS),
  principles: list,
  bestPractices: list,
  antiPatterns: list,
  frameworks: list,
});

const bundleSchema = z.strictObject({
  format: z.literal(SKILL_BUNDLE_FORMAT, { error: `not a skill bundle: format must be "${SKILL_BUNDLE_FORMAT}"` }),
  version: z.number().superRefine((v, ctx) => {
    if (v === SKILL_BUNDLE_VERSION) return;
    ctx.addIssue({ code: 'custom', message: v > SKILL_BUNDLE_VERSION
      ? `bundle version ${v} is newer than this Octipus reads (${SKILL_BUNDLE_VERSION}); upgrade Octipus to import it`
      : `unsupported bundle version ${v} (this Octipus reads ${SKILL_BUNDLE_VERSION})` });
  }),
  skills: z.array(bundleSkillSchema).min(1).max(MAX_BUNDLE_SKILLS),
  contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/, 'must be sha256:<64 lowercase hex>'),
  signature: z.strictObject({
    alg: z.literal('ed25519'),
    keyId: z.string().refine(isKeyId, 'must be ed25519:<64 hex>'),
    signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/, 'must be base64 of 64 bytes'),
  }).nullable(),
});

/** Zod's issues in one message, naming the path of each; an unknown field says what a bundle may carry. */
function describeIssues(error: z.ZodError): string {
  return error.issues.slice(0, 5).map((issue) => {
    const where = issue.path.length > 0 ? issue.path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${String(p)}`)).join('').replace(/^\./, '') : 'bundle';
    if (issue.code === 'unrecognized_keys') {
      const inSkill = issue.path.length === 2 && issue.path[0] === 'skills';
      return `${where}: ${issue.keys.map((k) => `"${k}"`).join(', ')} not accepted — ${inSkill
        ? `a bundle skill carries only ${BUNDLE_SKILL_FIELDS.join(', ')}; ids, owners, trust flags, triggers, tool grants and usage data are never imported`
        : 'unknown field'}`;
    }
    return `${where}: ${issue.message}`;
  }).join('; ');
}

function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/** A bundle skill with its fields in the canonical order (the order the hash is computed in). */
function canonicalSkill(skill: BundleSkill): BundleSkill {
  return {
    name: skill.name,
    category: skill.category,
    description: skill.description,
    content: skill.content,
    principles: [...skill.principles],
    bestPractices: [...skill.bestPractices],
    antiPatterns: [...skill.antiPatterns],
    frameworks: [...skill.frameworks],
  };
}

/** The content hash of a bundle's skills: sha256 of the canonical JSON of format, version and skills. */
export function bundleContentHash(skills: readonly BundleSkill[]): string {
  return sha256(JSON.stringify({ format: SKILL_BUNDLE_FORMAT, version: SKILL_BUNDLE_VERSION, skills: skills.map(canonicalSkill) }));
}

/** A DB skill as a bundle carries it: the content and metadata, none of the row's ids, owner, flags or counters. */
export function toBundleSkill(row: Pick<SkillView, (typeof BUNDLE_SKILL_FIELDS)[number]>): BundleSkill {
  return canonicalSkill({
    name: row.name,
    category: row.category,
    description: row.description,
    content: row.content ?? '',
    principles: row.principles ?? [],
    bestPractices: row.bestPractices ?? [],
    antiPatterns: row.antiPatterns ?? [],
    frameworks: row.frameworks ?? [],
  });
}

/** A bundle of skills, unsigned, or signed with a publisher key when one is given. */
export function buildBundle(skills: readonly BundleSkill[], signingKey?: SigningKey): SkillBundle {
  if (skills.length === 0) throw new SkillBundleError('Choose at least one skill to export');
  if (skills.length > MAX_BUNDLE_SKILLS) throw new SkillBundleError(`A bundle carries at most ${MAX_BUNDLE_SKILLS} skills; export fewer at a time`);
  const canonical = skills.map(canonicalSkill);
  const contentHash = bundleContentHash(canonical);
  return {
    format: SKILL_BUNDLE_FORMAT,
    version: SKILL_BUNDLE_VERSION,
    skills: canonical,
    contentHash,
    signature: signingKey === undefined ? null : signSkillBundle(contentHash, signingKey),
  };
}

/** Sign an existing bundle (what `octi plugin sign-skill-bundle` does): re-checked, then signed over its content hash. */
export function signBundle(text: string, signingKey: SigningKey): SkillBundle {
  return buildBundle(parseSkillBundle(text).skills, signingKey);
}

/** A bundle or SKILL.md as read: its skills, content hash, signature, and what was left out of it. */
export interface ParsedImport {
  skills: BundleSkill[];
  contentHash: string;
  signature: SignatureFile | null;
  warnings: string[];
}

function checkSize(text: string, what: string): void {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_BUNDLE_BYTES) throw new SkillBundleError(`The ${what} is ${bytes} bytes; at most ${MAX_BUNDLE_BYTES} are read`);
}

function refuseDuplicateNames(skills: readonly BundleSkill[]): void {
  const seen = new Set<string>();
  for (const s of skills) {
    const key = s.name.trim().toLowerCase();
    if (seen.has(key)) throw new SkillBundleError(`The bundle names "${s.name}" twice; skill names in a bundle are unique`);
    seen.add(key);
  }
}

/**
 * Read a bundle's text: size, JSON, the strict schema, unique names, and its
 * content hash recomputed from the skills — a bundle changed after it was
 * hashed is refused here, before its signature is looked at.
 */
export function parseSkillBundle(text: string): ParsedImport {
  checkSize(text, 'bundle');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new SkillBundleError(`The bundle is not valid JSON: ${(err as Error).message}`);
  }
  return parseBundleJson(json);
}

function parseBundleJson(json: unknown): ParsedImport {
  const result = bundleSchema.safeParse(json);
  if (!result.success) throw new SkillBundleError(`Not a valid skill bundle: ${describeIssues(result.error)}`);
  const bundle = result.data;
  refuseDuplicateNames(bundle.skills);
  const actual = bundleContentHash(bundle.skills);
  if (actual !== bundle.contentHash) {
    throw new SkillBundleError(`The bundle's skills hash to ${actual}, not to its contentHash ${bundle.contentHash}: it was changed after it was exported; not imported`);
  }
  return { skills: bundle.skills.map(canonicalSkill), contentHash: actual, signature: bundle.signature, warnings: [] };
}

/** Frontmatter fields of a SKILL.md the import reads; any other is reported as left out. */
const SKILL_MD_FIELDS = new Set(['name', 'description', 'category']);
/**
 * Where `GET /api/skills/export?format=markdown` starts the next skill: its
 * separator (`skillsToMarkdown` joins with `\n---\n\n`) right before a
 * frontmatter that opens with `name:`, as `skillToMarkdown` writes it. A
 * horizontal rule inside a body, or a frontmatter's closing line before an
 * empty body, is not followed by one, so neither splits a skill.
 */
const LEGACY_MARKDOWN_SEPARATOR = /\n---\n\n(?=---\nname:)/;

/** The fields a portable skill (an old export, a SKILL.md) may have before its defaults are filled in. */
interface LooseSkill {
  name: string;
  category?: string;
  description: string;
  content?: string;
  principles?: string[];
  bestPractices?: string[];
  antiPatterns?: string[];
  frameworks?: string[];
}

/** A skill from a portable object, its absent fields defaulted, through the strict schema. */
function strictSkill(portable: LooseSkill, where: string): BundleSkill {
  const result = bundleSkillSchema.safeParse({
    name: portable.name,
    category: portable.category ?? 'general',
    description: portable.description,
    content: portable.content ?? '',
    principles: portable.principles ?? [],
    bestPractices: portable.bestPractices ?? [],
    antiPatterns: portable.antiPatterns ?? [],
    frameworks: portable.frameworks ?? [],
  });
  if (!result.success) throw new SkillBundleError(`Not a valid skill (${where}): ${describeIssues(result.error)}`);
  return canonicalSkill(result.data);
}

/** The parsed skills of an unsigned import, with the checks every import gets: count, unique names, the content hash. */
function unsignedImport(skills: BundleSkill[], warnings: string[]): ParsedImport {
  if (skills.length === 0) throw new SkillBundleError('There is no skill in it');
  refuseDuplicateNames(skills);
  return { skills, contentHash: bundleContentHash(skills), signature: null, warnings };
}

function tooMany(count: number): SkillBundleError {
  return new SkillBundleError(`At most ${MAX_BUNDLE_SKILLS} skills are imported at once; this has ${count}`);
}

/**
 * Read an agentskills.io SKILL.md (frontmatter + body) with the parser
 * mounted skills use — or several, as `GET /api/skills/export?format=markdown`
 * writes them. Each is parsed once. It has no signature: it imports as
 * unsigned, so `plugins.requireSignature` refuses it. Frontmatter fields
 * Octipus does not store (`allowed-tools`, `license`, `metadata`, …) are left
 * out, and named in the warnings — an imported skill grants no tools.
 */
export function parseSkillMdImport(md: string): ParsedImport {
  checkSize(md, 'SKILL.md');
  const chunks = md.split(LEGACY_MARKDOWN_SEPARATOR);
  if (chunks.length > MAX_BUNDLE_SKILLS) throw tooMany(chunks.length);
  const ignored = new Set<string>();
  const skills = chunks.map((chunk, i) => {
    const which = chunks.length === 1 ? 'The SKILL.md' : `Skill ${i + 1}`;
    const parsed = parseSkillMd(chunk);
    if (!parsed) throw new SkillBundleError(`${which} has no name or no description in its frontmatter (both are required by the agentskills.io spec)`);
    for (const key of parsed.frontmatterKeys) if (!SKILL_MD_FIELDS.has(key)) ignored.add(key);
    return strictSkill(parsed.skill, which.toLowerCase());
  });
  const warnings = ignored.size > 0
    ? [`Frontmatter ${[...ignored].map((k) => `"${k}"`).join(', ')} not imported: Octipus stores a skill's name, category, description and body only, and an imported skill grants no tools`]
    : [];
  return unsignedImport(skills, warnings);
}

/** The fields an old export may carry that the import keeps. */
const LEGACY_FIELDS = new Set<string>(BUNDLE_SKILL_FIELDS);

/**
 * Read what `GET /api/skills/export` (`{ skills: [...] }`) or
 * `GET /api/skills/:id/export` (one skill) writes — the JSON from before
 * bundles: no hash, no signature, so it imports as unsigned. Its skills go
 * through the same strict per-skill schema and limits; any other field (an
 * id, an owner, a flag an older export carried) is dropped and named in the
 * warnings — never installed.
 */
export function parseLegacyExport(json: unknown): ParsedImport {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new SkillBundleError('Not a skill bundle or an export of skills');
  const doc = json as Record<string, unknown>;
  const many = Array.isArray(doc.skills);
  const items: unknown[] = many ? doc.skills as unknown[] : [doc];
  if (items.length > MAX_BUNDLE_SKILLS) throw tooMany(items.length);
  const dropped = new Set<string>();
  if (many) for (const key of Object.keys(doc)) if (key !== 'skills') dropped.add(key);
  const skills = items.map((item, i) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new SkillBundleError(`skills[${i}] is not a skill`);
    const kept: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(item)) {
      if (LEGACY_FIELDS.has(key)) kept[key] = value;
      else dropped.add(key);
    }
    return strictSkill(kept as unknown as LooseSkill, many ? `skills[${i}]` : 'the skill');
  });
  const warnings = ['An export from before skill bundles: it has no content hash or signature, so it imports as unsigned'];
  if (dropped.size > 0) {
    warnings.push(`Not imported: ${[...dropped].map((k) => `"${k}"`).join(', ')} — an import keeps only ${BUNDLE_SKILL_FIELDS.join(', ')}; ids, owners, trust flags, triggers, tool grants and usage data are never installed`);
  }
  return unsignedImport(skills, warnings);
}

/**
 * Read pasted or uploaded JSON: a skill bundle when it has `format`, else an
 * export from before bundles (`parseLegacyExport`).
 */
export function parseImportJson(text: string): { legacy: boolean; parsed: ParsedImport } {
  checkSize(text, 'bundle');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new SkillBundleError(`The bundle is not valid JSON: ${(err as Error).message}`);
  }
  const isBundle = typeof json === 'object' && json !== null && !Array.isArray(json) && 'format' in json;
  return isBundle ? { legacy: false, parsed: parseBundleJson(json) } : { legacy: true, parsed: parseLegacyExport(json) };
}

/** What the trust settings say of an import: the signature check, and the refusal when they do not accept it. */
export interface BundleTrust {
  check: SignatureCheck;
  view: BundleSignatureView;
  refusal: string | null;
  warnings: string[];
}

function signatureView(check: SignatureCheck): BundleSignatureView {
  switch (check.status) {
    case 'valid': return { status: 'valid', publisher: check.publisher, keyId: check.keyId, detail: `Signed by ${check.publisher}` };
    case 'unsigned': return { status: 'unsigned', publisher: null, keyId: null, detail: 'Not signed' };
    case 'unknown_key': return { status: 'unknown_key', publisher: null, keyId: check.keyId, detail: `Signed by a key not in plugins.trustedPublishers (${check.keyId})` };
    case 'revoked':
    case 'expired': return { status: check.status, publisher: check.publisher, keyId: check.keyId, detail: `Signed, but ${check.detail}` };
    case 'invalid': return { status: 'invalid', publisher: null, keyId: null, detail: check.reason };
  }
}

/**
 * Check an import's signature against the plugin package trust settings,
 * read now so a config change applies to the next import:
 * `plugins.trustedPublishers` (an entry's `revoked` and `notAfter`
 * included) and `plugins.revokedKeys`. As for a plugin package: an invalid
 * signature, or one by a revoked key, is always refused; unsigned, an
 * unknown key or an expired one are refused under
 * `plugins.requireSignature`, or when `requireTrusted` (a URL import), and
 * otherwise imported as unsigned (an unknown or expired key with a warning).
 */
export function checkBundleTrust(contentHash: string, signature: SignatureFile | null, opts: { requireTrusted: boolean }): BundleTrust {
  const plugins = getConfig().plugins;
  const ring = trustedKeys(plugins?.trustedPublishers ?? [], (publisher, reason) => {
    coreLogger.warn({ publisher, reason }, 'A key in plugins.trustedPublishers cannot be read; it trusts nothing');
  }, { revokedKeys: plugins?.revokedKeys ?? [] });
  const check = verifySkillBundle(contentHash, signature, ring);
  const view = signatureView(check);
  if (check.status === 'valid') return { check, view, refusal: null, warnings: [] };
  const shortfall = check.status === 'invalid' ? `The bundle's signature is invalid: ${check.reason}`
    : check.status === 'revoked' ? `The bundle is signed by a revoked key: ${check.detail}`
    : view.detail;
  if (check.status === 'invalid' || check.status === 'revoked') return { check, view, refusal: `${shortfall}; not imported`, warnings: [] };
  if (opts.requireTrusted) return { check, view, refusal: `${shortfall}; a bundle fetched from a URL must carry a valid signature by a trusted publisher`, warnings: [] };
  if (plugins?.requireSignature === true) return { check, view, refusal: `${shortfall}; plugins.requireSignature accepts only bundles signed by a trusted publisher`, warnings: [] };
  if (check.status === 'unknown_key' || check.status === 'expired') return { check, view, refusal: null, warnings: [`${shortfall}: imports as unsigned`] };
  return { check, view, refusal: null, warnings: [] };
}

/** Why a server export is unsigned: the instance holds no publisher signing key. */
export const UNSIGNED_EXPORT_NOTE = 'Unsigned: this Octipus holds no publisher signing key (publisher keys stay offline, as for plugin packages). '
  + 'Sign the file with `octi plugin sign-skill-bundle <file> --key <publisher.key>`; an importer trusts it when that key is in their plugins.trustedPublishers.';
