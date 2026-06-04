/**
 * Persist a finished research report (feature #5) as a first-class Document and
 * index it into the knowledge base, so the report can be browsed in the
 * Documents view and referenced (RAG-retrieved) by future agent turns.
 *
 * The report is written as Markdown to the user's documents storage, recorded
 * in the `documents` table with status 'completed', and indexed via the same
 * embedding path the document processor uses. Knowledge indexing is fail-soft:
 * if no embedding model is configured we still keep the document (and log why),
 * rather than throwing away a successful research run.
 */
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getConfig } from '@/config';
import { getEmbeddingService } from '@/core/rag/embeddings';
import { documentRepository } from '@/db/repositories/document-repository';
import { coreLogger } from '@/utils/logger';
import type { ReportDoc } from './types';

/** Serialize a ReportDoc to a self-contained Markdown document. */
export function renderReportMarkdown(report: ReportDoc): string {
  const orderById = new Map(report.sources.map((s, i) => [s.id, i + 1]));
  const lines: string[] = [];
  lines.push(`# ${report.question}`, '');
  lines.push(
    `_Depth: ${report.depth} · Generated ${report.generatedAt} · ${report.sources.length} sources_`,
    '',
  );
  for (const sec of report.sections) {
    lines.push(`## ${sec.heading}`, '');
    lines.push(sec.markdown.trim(), '');
    const marks = sec.citations
      .map((id) => orderById.get(id))
      .filter((n): n is number => n !== undefined);
    if (marks.length) lines.push(`Sources: ${marks.map((n) => `[${n}]`).join(' ')}`, '');
  }
  lines.push('## Limitations', '', report.limitations.trim(), '');
  lines.push('## Sources', '');
  report.sources.forEach((s, i) => {
    lines.push(`${i + 1}. [${s.title}](${s.url}) — retrieved ${s.retrievedAt}`);
  });
  lines.push('');
  return lines.join('\n');
}

/** A short, human-readable document title derived from the research question. */
function reportTitle(question: string): string {
  const q = question.trim().replace(/\s+/g, ' ');
  const short = q.length > 80 ? `${q.slice(0, 77)}…` : q;
  return `Research — ${short}`;
}

/**
 * Write the report to disk, record it as a Document, and index it into the
 * knowledge base. Returns the new document id (or null if persistence failed —
 * the caller keeps the in-memory report either way).
 */
export async function persistReport(report: ReportDoc, userId: string): Promise<string | null> {
  const markdown = renderReportMarkdown(report);
  const bytes = Buffer.byteLength(markdown, 'utf8');

  try {
    const documentsRoot = resolve(getConfig().workspace.documentsPath || './workspace/documents');
    const dir = join(documentsRoot, 'users', userId, 'workspaces', 'default', 'research');
    await mkdir(dir, { recursive: true });

    const filename = `${globalThis.crypto.randomUUID()}.md`;
    const storagePath = join(dir, filename);
    await Bun.write(storagePath, markdown);

    const doc = await documentRepository.create({
      userId,
      filename,
      originalName: `${reportTitle(report.question)}.md`,
      mimeType: 'text/markdown',
      size: bytes,
      category: 'Research',
      ocrText: markdown,
      summary: report.sections[0]?.markdown.slice(0, 500) ?? report.limitations.slice(0, 500),
      status: 'completed',
      storagePath,
      processedAt: new Date(),
      metadata: { source: 'research', question: report.question, depth: report.depth },
    });

    // Fail-soft KB indexing: a missing embedding model must not discard the
    // research output. The document is already saved and browsable.
    try {
      const stored = await getEmbeddingService().indexText(
        'document',
        `doc:${doc.id}`,
        markdown,
        { filePath: storagePath },
        doc.id,
      );
      coreLogger.info({ documentId: doc.id, chunksStored: stored }, 'research: report indexed into knowledge base');
    } catch (err) {
      coreLogger.warn(
        { documentId: doc.id, err: (err as Error).message },
        'research: report saved but knowledge indexing failed (no embedding model?)',
      );
    }

    return doc.id;
  } catch (err) {
    coreLogger.error({ userId, err: (err as Error).message }, 'research: failed to persist report document');
    return null;
  }
}
