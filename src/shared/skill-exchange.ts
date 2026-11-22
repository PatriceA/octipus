/**
 * The skill exchange bundle (docs/SKILL-EXCHANGE.md): skills exported as one
 * versioned JSON file, with a content hash and an optional detached Ed25519
 * signature by a plugin publisher key. Shared by the server
 * (src/skills/exchange.ts, the routes) and the web Skills page; types only,
 * so the web bundle pulls in no server code.
 */

export const SKILL_BUNDLE_FORMAT = 'octipus-skill-bundle';
export const SKILL_BUNDLE_VERSION = 1;

/** One skill as a bundle carries it: what recreates it, nothing about the instance or the person it came from. */
export interface BundleSkill {
  name: string;
  category: string;
  description: string;
  content: string;
  principles: string[];
  bestPractices: string[];
  antiPatterns: string[];
  frameworks: string[];
}

export interface BundleSignature {
  alg: 'ed25519';
  keyId: string;
  signature: string;
}

export interface SkillBundle {
  format: typeof SKILL_BUNDLE_FORMAT;
  version: typeof SKILL_BUNDLE_VERSION;
  skills: BundleSkill[];
  /** `sha256:<hex>` over the canonical form of `format`, `version` and `skills`. */
  contentHash: string;
  /** Detached signature over the content hash, or null: unsigned. */
  signature: BundleSignature | null;
}

/** What `GET /api/skills/exchange/export` answers: the bundle, and whether (and why not) it is signed. */
export interface SkillBundleExport {
  bundle: SkillBundle;
  signed: boolean;
  note: string;
}

/** Where an import comes from: a pasted or uploaded bundle, an agentskills.io SKILL.md, or an https URL (admins). */
export type SkillImportSourceKind = 'bundle' | 'skill_md' | 'url';

/** A request's source: exactly one of these. */
export interface SkillImportSource {
  bundle?: string;
  skillMd?: string;
  url?: string;
}

export type BundleSignatureStatus = 'valid' | 'unsigned' | 'unknown_key' | 'expired' | 'revoked' | 'invalid';

export interface BundleSignatureView {
  status: BundleSignatureStatus;
  /** The trusted publisher whose key it is (valid, expired or revoked by a listed key), else null. */
  publisher: string | null;
  keyId: string | null;
  detail: string;
}

/** A skill the caller can already see under the same name (case-insensitive). */
export interface SkillImportCollision {
  id: string;
  name: string;
  /** own: the caller's; system: shipped or admin-wide; shared: another user's, through an organization; mounted: a SKILL.md folder. */
  kind: 'own' | 'system' | 'shared' | 'mounted';
  /** Whether the caller may replace it with the imported skill. */
  canReplace: boolean;
}

export interface SkillImportPreviewItem {
  skill: BundleSkill;
  collision: SkillImportCollision | null;
}

/** What `POST /api/skills/exchange/preview` answers. Nothing has been written. */
export interface SkillImportPreview {
  source: SkillImportSourceKind;
  url: string | null;
  contentHash: string;
  signature: BundleSignatureView;
  /** False when the trust settings refuse it; `refusal` says why. */
  installable: boolean;
  refusal: string | null;
  warnings: string[];
  skills: SkillImportPreviewItem[];
}

/**
 * What to do with one bundle skill, by its name in the bundle. A skill with
 * no collision is created unless told otherwise; one with a collision needs
 * `skip`, `rename` or `replace` (the colliding skill's id) — never a silent overwrite.
 */
export type SkillImportDecision =
  | { name: string; action: 'create' }
  | { name: string; action: 'skip' }
  | { name: string; action: 'rename'; newName: string }
  | { name: string; action: 'replace'; skillId: string };

/** What `POST /api/skills/exchange/install` answers. */
export interface SkillImportResult {
  created: Array<{ id: string; name: string }>;
  replaced: Array<{ id: string; name: string }>;
  skipped: string[];
  contentHash: string;
  signature: BundleSignatureView;
}
