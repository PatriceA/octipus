import { join } from 'path';
import { type EmbeddingPurpose, getEmbeddingService, sha256Hex } from '@/core/rag/embeddings';
import { isKBReady } from '@/core/rag/health';
import { logger } from '@/utils/logger';
import { fileAt, globFiles } from '@/utils/fs-file';

/**
 * Auto-index Octipus's own product documentation into the knowledge base so
 * end users can ask the assistant "how do I set up Telegram / a model provider
 * / X?" and get an answer grounded in the shipped docs instead of a guess.
 *
 * Rows are written GLOBAL (`user_id = NULL`, via the default `indexText`
 * scope) and tagged `metadata.source = 'octipus-docs'` so the `/docs` command
 * and the `search_knowledge` tool can scope to / recognise the corpus. The
 * docs are the same for every tenant, so a single global copy is correct and
 * avoids re-embedding the manual once per user.
 *
 * Idempotent: each chunk is stamped with the source file's SHA-256
 * (`metadata.fileSha`); a re-run skips any file whose content is unchanged,
 * so this is cheap to call at every boot and on a cron refresh.
 */

const log = logger.child({ component: 'seed-docs' });

const DOCS_SOURCE = 'octipus-docs';
const DOC_PURPOSE: EmbeddingPurpose = 'document';

/**
 * Globs (relative to the docs dir) for the user-facing manual. Top-level
 * guides plus the architecture/ and guides/ subtrees. Internal/noise trees
 * (plans, superpowers, images) are intentionally not matched.
 */
const INCLUDE_PATTERNS = ['*.md', 'architecture/**/*.md', 'guides/**/*.md'];

/**
 * Even within the matched set, drop high-churn / low-signal files that would
 * pollute "how do I set up X" retrieval. Matched against the path relative to
 * the docs dir, case-insensitively.
 */
function isExcluded(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  if (lower.includes('changelog')) return true; // CHANGELOG.md, WEEKLY-CHANGELOG-*
  if (lower === 'qa.md') return true;
  // Defensive: never index these trees even if a future glob widens.
  if (lower.startsWith('plans/') || lower.startsWith('superpowers/') || lower.startsWith('images/')) return true;
  return false;
}

/** Minimal seam so the unit test can drive this without a DB / embedding provider. */
export interface IndexProductDocsDeps {
  docsDir?: string;
  isReady?: () => boolean;
  /** Defaults to the real EmbeddingService singleton. */
  service?: {
    isFileIndexed(purpose: EmbeddingPurpose, sourceId: string, fileContent: string, globalOnly?: boolean): Promise<boolean>;
    deleteBySource(purpose: EmbeddingPurpose, sourceId: string, globalOnly?: boolean): Promise<number>;
    indexText(
      purpose: EmbeddingPurpose,
      sourceId: string,
      content: string,
      metadata?: Record<string, unknown>,
    ): Promise<number>;
  };
  /** Defaults to Bun.Glob scan of `docsDir`. Returns paths RELATIVE to docsDir. */
  listFiles?: (docsDir: string, patterns: string[]) => Promise<string[]>;
  /** Defaults to `fileAt(absPath).text()`. */
  readFile?: (absPath: string) => Promise<string>;
}

export interface IndexProductDocsResult {
  ran: boolean;
  reason?: string;
  filesIndexed: number;
  filesSkipped: number;
  chunksStored: number;
}

async function defaultListFiles(docsDir: string, patterns: string[]): Promise<string[]> {
  const seen = new Set<string>();
  for (const pattern of patterns) {

    // `absolute: false` → paths relative to cwd (docsDir); don't follow
    // symlinks out of the docs tree. NB: scan() rejects with ENOENT if
    // `docsDir` does not exist — the caller catches that as "no docs".
    for await (const rel of globFiles(pattern, { cwd: docsDir, absolute: false })) {
      seen.add(rel);
    }
  }
  return [...seen];
}

/**
 * Index the product docs. Never throws — a docs-index failure must not abort
 * boot, mirroring the other isolated seed steps. Returns a summary for logs
 * and tests.
 */
export async function indexProductDocs(deps: IndexProductDocsDeps = {}): Promise<IndexProductDocsResult> {
  const result: IndexProductDocsResult = { ran: false, filesIndexed: 0, filesSkipped: 0, chunksStored: 0 };
  try {
    const docsDir = deps.docsDir ?? join(process.cwd(), 'docs');

    // Docs only ship in some images / dev trees; absence is normal, not an
    // error. The glob scan is the existence check — but Bun.Glob.scan THROWS
    // ENOENT when `cwd` doesn't exist (it does not yield zero files), so the
    // try/catch below is what turns a missing docs dir into a clean skip.
    const listFiles = deps.listFiles ?? defaultListFiles;
    let relPaths: string[];
    try {
      relPaths = await listFiles(docsDir, INCLUDE_PATTERNS);
    } catch (err) {
      log.info({ err, docsDir }, 'Product docs directory missing or not scannable — skipping docs auto-index');
      result.reason = 'docs-dir-missing';
      return result;
    }
    if (relPaths.length === 0) {
      log.info({ docsDir }, 'No product docs found — skipping docs auto-index');
      result.reason = 'docs-dir-missing';
      return result;
    }

    const isReady = deps.isReady ?? isKBReady;
    if (!isReady()) {
      log.info('Knowledge base not ready (no embedding model / vector store) — skipping docs auto-index; the cron refresh will retry once it is');
      result.reason = 'kb-not-ready';
      return result;
    }

    const included = relPaths.filter((rel) => !isExcluded(rel)).sort();
    if (included.length === 0) {
      log.info({ docsDir }, 'Product docs directory had no indexable files after exclusions');
      result.reason = 'no-files';
      result.ran = true;
      return result;
    }

    const service = deps.service ?? getEmbeddingService();
    const readFile = deps.readFile ?? ((absPath: string) => fileAt(absPath).text());

    result.ran = true;
    for (const rel of included) {
      const absPath = join(docsDir, rel);
      try {
        const content = await readFile(absPath);
        if (!content.trim()) {
          result.filesSkipped++;
          continue;
        }
        const fileSha = sha256Hex(content);

        // Skip the expensive re-embed when the file is byte-for-byte unchanged
        // since the last index (fileSha stamped on its chunks). `globalOnly`
        // restricts the check to GLOBAL rows so a per-user document at the same
        // path can't mask the global file as already-indexed.
        if (await service.isFileIndexed(DOC_PURPOSE, absPath, content, true)) {
          result.filesSkipped++;
          continue;
        }

        // Content changed (or first index) — drop stale chunks for this file
        // so an edit that shrinks the doc doesn't leave orphan chunks, then
        // re-index. Rows are GLOBAL (indexText default ownerUserId = null), and
        // `globalOnly` keeps this purge from touching any per-user row.
        await service.deleteBySource(DOC_PURPOSE, absPath, true);
        const chunks = await service.indexText(DOC_PURPOSE, absPath, content, {
          filePath: absPath,
          language: 'markdown',
          source: DOCS_SOURCE,
          fileSha,
        });
        result.filesIndexed++;
        result.chunksStored += chunks;
      } catch (err) {
        // One bad file must not abort the rest of the corpus.
        log.warn({ err, file: rel }, 'Failed to index a product doc — continuing with the rest');
      }
    }

    log.info(
      { filesIndexed: result.filesIndexed, filesSkipped: result.filesSkipped, chunksStored: result.chunksStored },
      'Product docs auto-index complete',
    );
    return result;
  } catch (err) {
    // Fully non-fatal, like the other seed steps.
    log.error({ err }, 'Product docs auto-index failed (non-fatal) — feature degraded, server continues');
    result.reason = 'error';
    return result;
  }
}
