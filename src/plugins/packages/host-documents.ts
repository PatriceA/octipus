/**
 * `documents:write` of the plugin host API (docs/PLUGIN-PACKAGES.md#host-api):
 * a package creates a text document as the calling user, and updates one it
 * created itself.
 *
 * - **As the user, in the call's workspace.** The row goes through
 *   `contentRepos(principal).documents`, so a space's role rules apply (a
 *   viewer cannot write: `SpaceError`), and the file lands under that
 *   workspace's documents directory, never another's.
 * - **Provenance.** The row's `metadata` carries `source: 'plugin'` and
 *   `sourceRef: { plugin, tool }`; only the package named there may update it.
 * - **Protection.** A new document is at least at the level of what the same
 *   call read through the host API (`HostTokenGrant.readLevel`), or higher when
 *   the package asks; one above the package's `maxProtection` cannot be
 *   updated by it (`403 protection_level`), as it cannot be read.
 * - **Text only.** Markdown or plain text, capped; stored as the file and as the
 *   document's text (`ocr_text`), so search, `documents:read` and the
 *   Documents page see it, and indexed into the knowledge base, fail-soft.
 */
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ContentRepos } from '@/db/repositories/content';
import type { DocumentRecord } from '@/db/schema/documents';
import { effectiveProtectionLevel, isProtectionLevel } from '@/shared/protection';
import { writeFileAt } from '@/utils/fs-file';
import { coreLogger } from '@/utils/logger';
import type { HostTokenGrant } from './host-api';

/** The most characters a document's content may have. */
export const MAX_DOCUMENT_CHARS = 500_000;

export const DOCUMENT_MIME_TYPES = ['text/markdown', 'text/plain'] as const;
export type HostDocumentMimeType = (typeof DOCUMENT_MIME_TYPES)[number];

export interface HostDocumentCreate {
  name: string;
  content: string;
  mimeType?: HostDocumentMimeType;
  category?: string;
  summary?: string;
  protectionLevel?: number;
}

export interface HostDocumentUpdate {
  content: string;
  name?: string;
  summary?: string;
}

export type HostDocumentOutcome =
  | { ok: true; id: string; name: string; protectionLevel: number; size: number }
  | { ok: false; status: number; code: string; error: string };

/** The provenance a plugin's document carries in `metadata`. */
export interface PluginDocumentSource { plugin: string; tool: string }

/** The package that created `doc`, from its provenance; null for any other document. */
export function documentPlugin(doc: Pick<DocumentRecord, 'metadata'>): string | null {
  const ref = (doc.metadata as { source?: unknown; sourceRef?: { plugin?: unknown } } | null)?.sourceRef;
  return (doc.metadata as { source?: unknown } | null)?.source === 'plugin' && typeof ref?.plugin === 'string' ? ref.plugin : null;
}

const extensionOf = (mime: HostDocumentMimeType) => (mime === 'text/markdown' ? 'md' : 'txt');

/** A file name a person can read: no path characters, one extension of the type. */
export function documentName(raw: string, mime: HostDocumentMimeType): string {
  const ext = extensionOf(mime);
  const base = raw.replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/\.(md|markdown|txt)$/i, '').slice(0, 150).replace(/[.\s]+$/, '');
  return `${base || 'document'}.${ext}`;
}

/** The directory a package's documents of this workspace are written to: beside its uploads, one per package. */
function documentDir(repos: ContentRepos, plugin: string): string {
  return join(dirname(repos.documents.uploadDirectory()), `plugin-${plugin}`);
}

async function indexDocument(repos: ContentRepos, doc: DocumentRecord, text: string, replace = false): Promise<void> {
  try {
    // No embedding model: nothing is chunked; the catch-up indexes the document once one is configured.
    const { capabilityConfigured } = await import('@/core/capabilities/gates');
    const embeddingOn = await capabilityConfigured('embedding');
    const owner = repos.knowledgeOwner;
    if (!embeddingOn && 'ownerUserId' in owner) {
      // The passages of the earlier text go now (deleting needs no model), so
      // nothing serves outdated content until the catch-up indexes the new one.
      if (replace) {
        const { getEmbeddingService } = await import('@/core/rag/embeddings');
        await getEmbeddingService().deleteBySource(owner, 'document', `doc:${doc.id}`);
      }
      const { recordSkipped } = await import('@/core/rag/index-backlog');
      await recordSkipped({
        kind: 'document', sourceId: doc.id, ownerUserId: owner.ownerUserId, workspaceId: owner.workspaceId,
        purpose: 'document', metadata: { filePath: doc.storagePath },
      });
      return;
    }
    if (!embeddingOn) return;
    const { getEmbeddingService } = await import('@/core/rag/embeddings');
    // An update replaces the passages of the earlier text.
    if (replace) await getEmbeddingService().deleteBySource(repos.knowledgeOwner, 'document', `doc:${doc.id}`);
    await getEmbeddingService().indexText(repos.knowledgeOwner, 'document', `doc:${doc.id}`, text, { filePath: doc.storagePath }, doc.id);
  } catch (err) {
    // The document is saved and browsable; only search over it waits for an embedding model.
    coreLogger.warn({ documentId: doc.id, err: (err as Error).message }, 'plugin-host: document saved but knowledge indexing failed');
  }
}

/** Create a document for the calling user (`POST /api/plugin-host/documents`). */
export async function createPluginDocument(grant: HostTokenGrant, repos: ContentRepos, req: HostDocumentCreate): Promise<HostDocumentOutcome> {
  repos.can('write');
  repos.assertOpen();
  const mime: HostDocumentMimeType = req.mimeType ?? 'text/markdown';
  if (req.protectionLevel !== undefined && !isProtectionLevel(req.protectionLevel)) {
    return { ok: false, status: 400, code: 'invalid', error: 'protectionLevel is 1, 2, 3 or 4' };
  }
  // What this call read is in it: never below that level, higher when asked.
  const level = Math.max(grant.readLevel ?? 1, req.protectionLevel ?? 1);
  const name = documentName(req.name, mime);
  const dir = documentDir(repos, grant.plugin);
  await mkdir(dir, { recursive: true });
  const stored = `${globalThis.crypto.randomUUID()}.${extensionOf(mime)}`;
  const storagePath = join(dir, stored);
  await writeFileAt(storagePath, req.content);
  const size = Buffer.byteLength(req.content, 'utf8');
  const doc = await repos.documents.create({
    filename: stored,
    originalName: name,
    mimeType: mime,
    size,
    category: req.category ?? null,
    ocrText: req.content,
    summary: req.summary ?? req.content.slice(0, 500),
    status: 'completed',
    storagePath,
    processedAt: new Date(),
    protectionLevel: level,
    metadata: { source: 'plugin', sourceRef: { plugin: grant.plugin, tool: grant.tool } satisfies PluginDocumentSource },
  });
  void indexDocument(repos, doc, req.content);
  return { ok: true, id: doc.id, name, protectionLevel: level, size };
}

/** Replace the content of a document the package created (`PUT /api/plugin-host/documents/:id`). */
export async function updatePluginDocument(
  grant: HostTokenGrant, repos: ContentRepos, id: string, req: HostDocumentUpdate,
): Promise<HostDocumentOutcome> {
  const doc = await repos.documents.findInScope(id);
  if (!doc) return { ok: false, status: 404, code: 'not_found', error: 'Document not found' };
  if (documentPlugin(doc) !== grant.plugin) {
    return { ok: false, status: 403, code: 'not_created_by_plugin', error: 'A package updates only the documents it created' };
  }
  const current = effectiveProtectionLevel(doc.protectionLevel);
  if (current > grant.maxProtection) {
    return { ok: false, status: 403, code: 'protection_level', error: `The document is at protection level ${current}; this package may see up to ${grant.maxProtection}` };
  }
  repos.can('write');
  repos.assertOpen();
  const mime: HostDocumentMimeType = (DOCUMENT_MIME_TYPES as readonly string[]).includes(doc.mimeType) ? doc.mimeType as HostDocumentMimeType : 'text/plain';
  const level = Math.max(current, grant.readLevel ?? 1);
  const name = req.name ? documentName(req.name, mime) : doc.originalName;
  await writeFileAt(doc.storagePath, req.content);
  const size = Buffer.byteLength(req.content, 'utf8');
  const updated = await repos.documents.updateContent(doc.id, {
    originalName: name, size, ocrText: req.content, summary: req.summary ?? req.content.slice(0, 500), protectionLevel: level,
  });
  if (!updated) return { ok: false, status: 404, code: 'not_found', error: 'Document not found' };
  void indexDocument(repos, updated, req.content, true);
  return { ok: true, id: doc.id, name, protectionLevel: level, size };
}
