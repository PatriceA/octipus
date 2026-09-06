/**
 * Tool-level test for `export_document` — the glue between the writers and the
 * user's Documents. What it proves is that the exported file actually lands
 * somewhere the user can fetch: a `documents` row owned by the caller, marked
 * completed so the OCR queue leaves it alone, with the bytes on disk at
 * `storagePath` and a download URL that names that row.
 *
 * Invocations use role:'general' so the base-tool permission gate is skipped
 * exactly as it is for spawned workers in production.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { ToolHandler } from '@/core/agent-worker';
import type { AgentContext } from '@/core/types';
import { DOCX_MIME, XLSX_MIME } from '@/core/documents/export';
import { DocumentsTool } from './index';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const aliceId = '11111111-1111-1111-1111-111111111111';
let tool: DocumentsTool;
let handlers: Map<string, ToolHandler>;

function ctx(userId: string): AgentContext {
  return {
    id: 'agent-1',
    sessionId: 'sess-1',
    userId,
    role: 'general',
    topic: 'writing',
    model: 'test',
    status: 'running',
    createdAt: new Date(),
    updatedAt: new Date(),
    metadata: {},
  } as AgentContext;
}

// biome-ignore lint/suspicious/noExplicitAny: tool results are open-shaped by design
const call = (name: string, args: Record<string, unknown>) =>
  handlers.get(name)!.execute(args, ctx(aliceId)) as Promise<any>;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-docs-tool-'));
  process.env.DOCUMENTS_PATH = mkdtempSync(join(tmpdir(), 'octipus-docs-out-'));
  const { initializeDb, executeRaw } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  await executeRaw(
    `INSERT INTO users (id, username, is_admin) VALUES ('${aliceId}', 'alice', false)
     ON CONFLICT DO NOTHING`,
  );

  tool = new DocumentsTool();
  await tool.initialize();
  handlers = (tool as unknown as { tools: Map<string, ToolHandler> }).tools;
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('export_document', () => {
  test('writes a docx the user can download', async () => {
    const res = await call('export_document', {
      title: 'Quarterly review',
      markdown: '# Quarterly review\n\nRevenue grew **12%**.\n',
    });
    expect(res.error).toBeUndefined();
    expect(res.format).toBe('docx');
    expect(res.filename).toBe('Quarterly review.docx');
    expect(res.mimeType).toBe(DOCX_MIME);
    expect(res.downloadUrl).toBe(`/api/documents/${res.documentId}/raw?download=1`);

    const { documentRepository } = await import('@/db/repositories/document-repository');
    const row = await documentRepository.findById(res.documentId);
    expect(row?.userId).toBe(aliceId);
    expect(row?.category).toBe('Exports');
    // Completed on creation: this file is our own output, so re-running the
    // extraction queue over it would only re-derive what we already had.
    expect(row?.status).toBe('completed');
    expect(readFileSync(row!.storagePath).subarray(0, 2).toString('latin1')).toBe('PK');
    expect(row?.size).toBe(res.size);
  }, 30_000);

  test('writes an xlsx from the markdown tables', async () => {
    const res = await call('export_document', {
      format: 'xlsx',
      title: 'Revenue',
      markdown: '## Regions\n\n| Region | Total |\n| - | - |\n| EMEA | 10 |\n',
    });
    expect(res.mimeType).toBe(XLSX_MIME);
    expect(res.filename).toBe('Revenue.xlsx');

    const { documentRepository } = await import('@/db/repositories/document-repository');
    const row = await documentRepository.findById(res.documentId);
    const XLSX = await import('xlsx');
    const book = XLSX.read(readFileSync(row!.storagePath), { type: 'buffer' });
    expect(book.SheetNames).toEqual(['Regions']);
  }, 30_000);

  test('says what is missing rather than writing an empty workbook', async () => {
    const res = await call('export_document', {
      format: 'xlsx',
      title: 'No tables',
      markdown: '# Prose only\n\nNothing tabular here.',
    });
    expect(res.error).toMatch(/at least one markdown table/);
    expect(res.documentId).toBeUndefined();
  });

  test('rejects an unknown format', async () => {
    const res = await call('export_document', { format: 'pdf', title: 'x', markdown: 'y' });
    expect(res.error).toContain('Unknown format "pdf"');
  });

  test('rejects an empty body', async () => {
    const res = await call('export_document', { title: 'x', markdown: '   ' });
    expect(res.error).toContain('markdown is empty');
  });
});
