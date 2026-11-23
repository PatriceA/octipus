/**
 * Skill registries (docs/SKILL-EXCHANGE.md#registries): static JSON indexes,
 * hosted anywhere, that list signed skill bundles. An operator lists the
 * registries to browse in `skills.registries`; none by default. Shared by the
 * server (src/skills/registry-index.ts, src/skills/registries.ts, the routes)
 * and the web Skills page; types and constants only.
 */
import type { BundleSignatureStatus } from './skill-exchange';

export const SKILL_INDEX_FORMAT = 'octipus-skill-index';
export const SKILL_INDEX_VERSION = 1;

/** One listing of an index: one bundle at one version. */
export interface SkillIndexEntry {
  /** The listing's identifier in its registry: lower-case letters, digits, `.`, `_` and `-`. */
  name: string;
  /** Semantic version (`1.2.0`, `1.2.0-beta.1`). */
  version: string;
  /** Plain text, one paragraph; shown as text, never as HTML or Markdown. */
  description: string;
  tags: string[];
  /** Who wrote it, as the registry says (display only: trust comes from the signature). */
  author: string | null;
  /** The key id the bundle is signed with (`ed25519:<64 hex>`), or null for an unsigned bundle. Checked against the bundle's signature. */
  publisherKeyId: string | null;
  /** The names of the skills in the bundle, in its order. Checked against the bundle. */
  skills: string[];
  /** Where the bundle is (https, a public host). */
  bundleUrl: string;
  /** `sha256:<hex>` of the exact bundle bytes served. */
  bundleSha256: string;
  /** The bundle's own `contentHash`. Checked against the bundle. */
  contentHash: string;
}

/** A registry index document. */
export interface SkillIndex {
  format: typeof SKILL_INDEX_FORMAT;
  version: typeof SKILL_INDEX_VERSION;
  /** When the index was built (ISO date-time with a zone), or null. */
  generatedAt: string | null;
  entries: SkillIndexEntry[];
}

/**
 * What the operator's trust settings say of the key an index entry claims,
 * before anything is downloaded: `valid` (a key of a publisher trusted for
 * this registry), `unsigned`, `unknown_key` (no such key, or a publisher not
 * trusted for this registry), `expired` or `revoked`. The bundle's signature
 * itself is verified at preview and install; this is a hint for browsing.
 */
export type ListedSignatureStatus = Exclude<BundleSignatureStatus, 'invalid'>;

/** One listing as `GET /api/skills/registry` answers it: the newest version of a name in a registry. */
export interface SkillRegistryListing extends SkillIndexEntry {
  registry: string;
  /** Older versions the index also lists, newest first. */
  olderVersions: string[];
  signature: { status: ListedSignatureStatus; publisher: string | null; detail: string };
  /** The version of this listing the caller installed from this registry, or null. */
  installedVersion: string | null;
  /** The content hash of what the caller installed, or null. */
  installedContentHash: string | null;
  /**
   * A higher version than the installed one is listed, with other content.
   * Shown only: nothing is updated without a preview and an install. A
   * version number is the registry's claim (signatures do not cover it).
   */
  updateAvailable: boolean;
}

export interface SkillRegistryListingResponse {
  /** The configured registries, by name (empty: none configured, nothing was fetched). */
  registries: string[];
  listings: SkillRegistryListing[];
  /** Registries that could not be read, and why. Their listings are left out; the others are listed. */
  errors: Array<{ registry: string; error: string }>;
  /** Entries of a readable index that were skipped, and why (at most 50). */
  problems: Array<{ registry: string; problem: string }>;
  /** More listings matched than one answer carries; narrow the search. */
  truncated: boolean;
}

/** An import from a registry: which listing (the preview and install download and check it). */
export interface SkillRegistrySource {
  registry: string;
  name: string;
  version: string;
}

/** A registry listing as a preview shows it: the source, and what the caller installed from it before. */
export interface SkillRegistryPreviewSource extends SkillRegistrySource {
  installed: { version: string; contentHash: string } | null;
}
