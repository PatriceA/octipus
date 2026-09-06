import { getEmbeddingService } from '@/core/rag/embeddings';
import type { ToolManifest } from '@/core/types';
import { documentRepository } from '@/db/repositories/document-repository';
import { BaseTool, createParameterSchema, type ToolAvailability } from '../base-tool';

export class DocumentsTool extends BaseTool {
  readonly id = 'documents';
  readonly name = 'Documents';
  readonly version = '1.0.0';
  readonly description = 'List, view, and search uploaded documents, and export a written deliverable as a Word document or a spreadsheet.';

  override async checkAvailability(): Promise<ToolAvailability> {
    try {
      const { getModelRegistry } = await import('@/models/model-registry');
      const registry = getModelRegistry();
      const visionModel = await registry.getModelForTopic('vision');
      const hasVision = visionModel?.topics?.includes('vision') ||
        (visionModel?.topicRoles && 'vision' in visionModel.topicRoles);
      if (!hasVision) {
        return { available: true, degraded: true, reason: 'No vision/OCR model configured — document processing limited' };
      }
      return { available: true };
    } catch {
      return { available: true, degraded: true, reason: 'No vision/OCR model configured' };
    }
  }

  getManifest(): ToolManifest {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      permissions: [
        { action: 'read', description: 'Read and list documents', defaultLevel: 'ALLOW' },
        { action: 'search', description: 'Search documents via knowledge base', defaultLevel: 'ALLOW' },
        { action: 'export', description: 'Write a document to the user\'s files as .docx or .xlsx', defaultLevel: 'ALLOW' },
      ],
      tools: [
        { name: 'list_documents', description: 'List uploaded documents with optional filters', parameters: { category: { type: 'string', description: 'Filter by category' }, status: { type: 'string', description: 'Filter by status' } }, returns: 'List of documents' },
        { name: 'get_document', description: 'Get document details including OCR text and summary', parameters: { id: { type: 'string', description: 'Document ID', required: true } }, returns: 'Document details with OCR text and summary' },
        { name: 'search_documents', description: 'Search documents using hybrid search', parameters: { query: { type: 'string', description: 'Search query', required: true } }, returns: 'Matching document entries' },
        { name: 'export_document', description: 'Export markdown as a .docx, or its tables as an .xlsx', parameters: { title: { type: 'string', description: 'Document title', required: true }, markdown: { type: 'string', description: 'Markdown body', required: true }, format: { type: 'string', description: 'docx or xlsx' } }, returns: 'The document id and a download URL' },
      ],
    };
  }

  protected async registerTools(): Promise<void> {
    this.registerTool(
      'list_documents',
      'List uploaded documents with optional category and status filters.',
      createParameterSchema({
        category: { type: 'string', description: 'Filter by category (invoices, contracts, reports, correspondence, technical, receipts, legal, medical, financial, other)' },
        status: { type: 'string', description: 'Filter by status (queued, processing, completed, failed)' },
        limit: { type: 'number', description: 'Max results (default: 20)', default: 20 },
      }),
      async (args) => {
        const limit = (args.limit as number) || 20;
        const category = args.category as string | undefined;
        const status = args.status as string | undefined;

        let docs;
        if (category) {
          docs = await documentRepository.findByCategory(category, limit);
        } else {
          docs = await documentRepository.listRecent(limit);
        }

        if (status) {
          docs = docs.filter(d => d.status === status);
        }

        if (docs.length === 0) {
          return { documents: [], message: 'No documents found.' };
        }

        return {
          documents: docs.map(d => ({
            id: d.id,
            originalName: d.originalName,
            mimeType: d.mimeType,
            size: d.size,
            category: d.category,
            status: d.status,
            summary: d.summary,
            createdAt: d.createdAt,
          })),
        };
      },
      { requiresPermission: false },
    );

    this.registerTool(
      'get_document',
      'Get full document details including OCR text and summary by document ID.',
      createParameterSchema({
        id: { type: 'string', description: 'The document ID', required: true },
      }),
      async (args) => {
        const doc = await documentRepository.findById(args.id as string);
        if (!doc) {
          return { error: 'Document not found.' };
        }

        return {
          id: doc.id,
          originalName: doc.originalName,
          mimeType: doc.mimeType,
          size: doc.size,
          category: doc.category,
          status: doc.status,
          ocrText: doc.ocrText,
          summary: doc.summary,
          storagePath: doc.storagePath,
          createdAt: doc.createdAt,
          processedAt: doc.processedAt,
          metadata: doc.metadata,
        };
      },
      { requiresPermission: false },
    );

    this.registerTool(
      'search_documents',
      'Search uploaded documents using hybrid search (semantic + keyword) over their indexed content.',
      createParameterSchema({
        query: { type: 'string', description: 'The search query', required: true },
        limit: { type: 'number', description: 'Max results (default: 5)', default: 5 },
      }),
      async (args) => {
        const service = getEmbeddingService();
        const limit = (args.limit as number) || 5;
        const results = await service.hybridSearch(args.query as string, limit, 'document');

        // Filter to only document-sourced entries (sourceId starts with "doc:")
        const docResults = results.filter(r => r.sourceId?.startsWith('doc:'));

        if (docResults.length === 0) {
          // Fall back to all document-type results
          if (results.length === 0) {
            return { results: [], message: 'No matching documents found.' };
          }
        }

        const finalResults = docResults.length > 0 ? docResults : results;

        return {
          results: finalResults.map(r => ({
            id: r.id,
            abstract: r.abstract || r.content.slice(0, 200),
            similarity: r.similarity.toFixed(3),
            sourceId: r.sourceId,
            filePath: r.metadata.filePath,
          })),
          hint: 'Use get_document with the document ID (from sourceId, format "doc:<uuid>") to get full details.',
        };
      },
      { requiresPermission: false },
    );

    this.registerTool(
      'export_document',
      'Turn a finished piece of writing into a file the user can open and send on. Give it the whole deliverable as markdown. format="docx" writes a Word document (headings, bold/italic, bullet and numbered lists, quotes, code blocks and tables all carry over); format="xlsx" writes a spreadsheet with one sheet per markdown table, named after the heading above each table. Returns a download URL. Use this when the user asks for a document, a report, a deck of numbers or "send me a file" — not for saving working notes, which belong in notes or filesystem.',
      createParameterSchema({
        title: { type: 'string', description: 'Document title — also the download filename', required: true },
        markdown: { type: 'string', description: 'The whole document as markdown', required: true },
        format: { type: 'string', description: 'docx (default) or xlsx', enum: ['docx', 'xlsx'], default: 'docx' },
        summary: { type: 'string', description: 'One-line summary shown in the documents list' },
      }),
      async (args, context) => {
        if (!context.userId) {
          throw new Error('export_document requires an authenticated user context');
        }
        const title = String(args.title ?? '').trim();
        const markdown = String(args.markdown ?? '');
        const format = String(args.format ?? 'docx').toLowerCase();
        if (format !== 'docx' && format !== 'xlsx') {
          return { error: `Unknown format "${format}" — use docx or xlsx` };
        }
        if (markdown.trim().length === 0) {
          return { error: 'markdown is empty — pass the document body' };
        }

        const {
          DOCX_MIME, DocumentExportError, XLSX_MIME,
          markdownToDocx, markdownToSheets, sheetsToXlsx,
        } = await import('@/core/documents/export');

        try {
          const content = format === 'docx'
            ? await markdownToDocx(markdown, { title })
            : await sheetsToXlsx(markdownToSheets(markdown));

          const { saveExportedDocument } = await import('@/core/documents/export-store');
          const saved = await saveExportedDocument({
            userId: context.userId,
            workspaceId: context.workspaceId ?? null,
            title: title.length > 0 ? title : 'Export',
            extension: format,
            mimeType: format === 'docx' ? DOCX_MIME : XLSX_MIME,
            content,
            summary: typeof args.summary === 'string' ? args.summary : undefined,
          });
          return { ...saved, format };
        } catch (error) {
          if (error instanceof DocumentExportError) return { error: error.message };
          throw error;
        }
      },
      { permissionAction: 'export' },
    );
  }
}

export const documentsTool = new DocumentsTool();
