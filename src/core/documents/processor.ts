import { readFile, mkdir, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, dirname, basename, join, extname } from 'path';
import { documentRepository } from '@/db/repositories/document-repository';
import { getEmbeddingService } from '@/core/rag/embeddings';
import { getLiteLLMClient } from '@/models/litellm-client';
import { getModelRegistry } from '@/models/model-registry';
import { getConfig } from '@/config';
import { coreLogger } from '@/utils/logger';
import type { AgentMessage } from '@/core/types';

// ── File type classification ─────────────────────────────────────────
// Instead of sending everything through OCR, we classify files into
// extraction strategies: direct text read, structured data parse, or OCR.

type ExtractionStrategy = 'text' | 'structured' | 'ocr';

const IMAGE_MIME_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/tiff', 'image/bmp', 'image/webp',
]);

/** Files that can be read as plain text directly */
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.csv', '.json', '.xml', '.yaml', '.yml', '.log', '.ini', '.conf', '.toml',
  '.html', '.htm', '.css', '.js', '.ts', '.py', '.sh', '.bash', '.sql', '.env',
]);

/** Structured documents where we can extract data without OCR */
const STRUCTURED_MIME_TYPES: Record<string, string> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.ms-powerpoint': 'ppt',
};

const STRUCTURED_EXTENSIONS = new Set([
  '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt',
]);

/**
 * Determine the best extraction strategy for a file.
 */
function classifyFile(mimeType: string, filename: string): ExtractionStrategy {
  // Images always need OCR
  if (IMAGE_MIME_TYPES.has(mimeType)) return 'ocr';

  // Structured Office documents — extract data directly
  if (STRUCTURED_MIME_TYPES[mimeType]) return 'structured';
  const ext = extname(filename).toLowerCase();
  if (STRUCTURED_EXTENSIONS.has(ext)) return 'structured';

  // PDFs — try text extraction first, may fall back to OCR
  if (mimeType === 'application/pdf') return 'ocr';

  // Plain text and code files — read directly
  if (TEXT_EXTENSIONS.has(ext)) return 'text';

  // Default: try text read
  return 'text';
}

const CATEGORIES = [
  'invoices', 'contracts', 'reports', 'correspondence', 'technical',
  'receipts', 'legal', 'medical', 'financial', 'other',
] as const;

export class DocumentProcessor {
  private logger = coreLogger.child({ component: 'document-processor' });

  /**
   * Process a single document through the OCR/categorization/indexing pipeline.
   */
  async process(documentId: string): Promise<void> {
    const doc = await documentRepository.findById(documentId);
    if (!doc) {
      this.logger.error({ documentId }, 'Document not found');
      return;
    }

    this.logger.info({ documentId, filename: doc.originalName, mimeType: doc.mimeType }, 'Processing document');

    try {
      // Step 1: Update status to processing
      await documentRepository.updateStatus(documentId, 'processing');

      // Step 2: Extract text content based on file type
      const strategy = classifyFile(doc.mimeType, doc.originalName);
      this.logger.info({ documentId, strategy, mimeType: doc.mimeType }, 'Extraction strategy selected');

      let extractedText: string;
      switch (strategy) {
        case 'structured':
          extractedText = await this.extractStructured(doc.storagePath, doc.originalName, doc.mimeType);
          break;
        case 'ocr':
          if (doc.mimeType === 'application/pdf') {
            extractedText = await this.extractPdfText(doc.storagePath);
          } else {
            extractedText = await this.ocrImage(doc.storagePath);
          }
          break;
        case 'text':
        default:
          extractedText = await this.readTextFile(doc.storagePath);
          break;
      }

      if (!extractedText || extractedText.trim().length === 0) {
        extractedText = `[No text content extracted from ${doc.originalName}]`;
      }

      // Step 3: Categorize
      const category = await this.categorize(extractedText, doc.originalName);

      // Step 4: Move file to category folder
      const newPath = await this.moveToCategory(doc.storagePath, category);

      // Step 5: Summarize
      const summary = await this.summarize(extractedText, doc.originalName);

      // Step 6: Index into knowledge base
      await this.indexDocument(documentId, extractedText, doc.originalName, category);

      // Step 7: Update DB
      await documentRepository.updateProcessed(documentId, {
        category,
        ocrText: extractedText,
        summary,
        status: 'completed',
        storagePath: newPath,
      });

      this.logger.info({ documentId, category, textLength: extractedText.length }, 'Document processed successfully');
    } catch (err) {
      this.logger.error({ err, documentId }, 'Document processing failed');
      await documentRepository.updateStatus(documentId, 'failed', String(err));
    }
  }

  /**
   * OCR an image using glm-ocr via Ollama API.
   */
  private async ocrImage(filePath: string): Promise<string> {
    const config = getConfig();
    const ocrEndpoint = config.workspace.ocrEndpoint || 'http://localhost:11435';
    const ocrModel = config.workspace.ocrModel || 'glm-ocr';

    const fileBuffer = await readFile(filePath);
    const base64Image = fileBuffer.toString('base64');

    const response = await fetch(`${ocrEndpoint}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ocrModel,
        prompt: 'Extract all text content from this image. Return only the extracted text, preserving the original layout as much as possible.',
        images: [base64Image],
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`OCR request failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as { response: string };
    return data.response || '';
  }

  /**
   * Extract text from a PDF file. For now, reads raw text content.
   * Image-based PDFs will need page extraction added later.
   */
  private async extractPdfText(filePath: string): Promise<string> {
    // Basic text extraction — read the file and attempt to extract text content.
    // For image-based PDFs, this won't yield much; OCR per page can be added later.
    const buffer = await readFile(filePath);
    const text = buffer.toString('utf-8');

    // Filter out binary noise — if it looks mostly like binary, return placeholder
    const printableRatio = text.replace(/[^\x20-\x7E\n\r\t]/g, '').length / text.length;
    if (printableRatio < 0.5) {
      return '[PDF contains primarily image-based content — OCR per page not yet implemented]';
    }

    return text;
  }

  /**
   * Read a text file directly.
   */
  private async readTextFile(filePath: string): Promise<string> {
    const buffer = await readFile(filePath, 'utf-8');
    return buffer;
  }

  /**
   * Extract content from structured documents (Word, Excel, PowerPoint)
   * without sending to OCR. Uses direct parsing of XML-based Office formats.
   */
  private async extractStructured(filePath: string, filename: string, mimeType: string): Promise<string> {
    const ext = extname(filename).toLowerCase();

    try {
      if (ext === '.xlsx' || ext === '.xls' || mimeType.includes('spreadsheet') || mimeType.includes('excel')) {
        return await this.extractExcel(filePath);
      }
      if (ext === '.docx' || mimeType.includes('wordprocessing')) {
        return await this.extractDocx(filePath);
      }
      if (ext === '.pptx' || mimeType.includes('presentation') || mimeType.includes('powerpoint')) {
        return await this.extractPptx(filePath);
      }
      if (ext === '.doc' || ext === '.ppt') {
        // Legacy binary formats — try to extract readable text
        return await this.extractLegacyOffice(filePath, filename);
      }
    } catch (err) {
      this.logger.warn({ err, filePath, ext }, 'Structured extraction failed, falling back to text read');
    }

    return this.readTextFile(filePath);
  }

  /**
   * Extract data from Excel (.xlsx) files by parsing the XML inside the ZIP.
   * Returns a text representation of all sheets with rows as tab-separated values.
   */
  private async extractExcel(filePath: string): Promise<string> {
    const jszip = await import('jszip');
    const JSZip = (jszip as any).default || jszip;
    const buffer = await readFile(filePath);
    const zip = await JSZip.loadAsync(buffer);

    // Read shared strings (Excel stores text in a shared string table)
    const sharedStrings: string[] = [];
    const ssFile = zip.file('xl/sharedStrings.xml');
    if (ssFile) {
      const ssXml = await ssFile.async('text');
      const matches = ssXml.matchAll(/<t[^>]*>([^<]*)<\/t>/g);
      for (const m of matches) {
        sharedStrings.push(m[1]);
      }
    }

    const lines: string[] = [];

    // Iterate over sheets
    const sheetFiles = Object.keys(zip.files).filter(f => f.match(/^xl\/worksheets\/sheet\d+\.xml$/)).sort();
    for (let si = 0; si < sheetFiles.length; si++) {
      const sheetXml = await zip.file(sheetFiles[si])!.async('text');
      lines.push(`--- Sheet ${si + 1} ---`);

      // Parse rows: <row> contains <c> cells
      const rows = sheetXml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g);
      for (const row of rows) {
        const cells: string[] = [];
        const cellMatches = row[1].matchAll(/<c\s+[^>]*?(?:t="([^"]*)")?[^>]*>[\s\S]*?(?:<v>([^<]*)<\/v>)?[\s\S]*?<\/c>/g);
        for (const cell of cellMatches) {
          const type = cell[1];
          const value = cell[2] || '';
          if (type === 's' && sharedStrings[parseInt(value, 10)] !== undefined) {
            cells.push(sharedStrings[parseInt(value, 10)]);
          } else {
            cells.push(value);
          }
        }
        if (cells.length > 0) {
          lines.push(cells.join('\t'));
        }
      }
      lines.push('');
    }

    return lines.join('\n') || '[Empty spreadsheet]';
  }

  /**
   * Extract text from Word (.docx) files by parsing document.xml inside the ZIP.
   */
  private async extractDocx(filePath: string): Promise<string> {
    const jszip = await import('jszip');
    const JSZip = (jszip as any).default || jszip;
    const buffer = await readFile(filePath);
    const zip = await JSZip.loadAsync(buffer);

    const docFile = zip.file('word/document.xml');
    if (!docFile) {
      return '[Could not find document.xml in DOCX]';
    }

    const xml = await docFile.async('text');

    // Extract text from paragraphs: <w:t> elements contain the text
    const paragraphs: string[] = [];
    const paraMatches = xml.matchAll(/<w:p[\s>]([\s\S]*?)<\/w:p>/g);
    for (const para of paraMatches) {
      const textParts: string[] = [];
      const textMatches = para[1].matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g);
      for (const t of textMatches) {
        textParts.push(t[1]);
      }
      paragraphs.push(textParts.join(''));
    }

    return paragraphs.filter(p => p.length > 0).join('\n') || '[Empty document]';
  }

  /**
   * Extract text from PowerPoint (.pptx) files by parsing slide XML inside the ZIP.
   */
  private async extractPptx(filePath: string): Promise<string> {
    const jszip = await import('jszip');
    const JSZip = (jszip as any).default || jszip;
    const buffer = await readFile(filePath);
    const zip = await JSZip.loadAsync(buffer);

    const lines: string[] = [];
    const slideFiles = Object.keys(zip.files).filter(f => f.match(/^ppt\/slides\/slide\d+\.xml$/)).sort();

    for (let si = 0; si < slideFiles.length; si++) {
      const slideXml = await zip.file(slideFiles[si])!.async('text');
      lines.push(`--- Slide ${si + 1} ---`);

      // Extract text from <a:t> elements
      const textMatches = slideXml.matchAll(/<a:t>([^<]*)<\/a:t>/g);
      const slideTexts: string[] = [];
      for (const t of textMatches) {
        if (t[1].trim()) slideTexts.push(t[1]);
      }
      lines.push(slideTexts.join('\n'));
      lines.push('');
    }

    return lines.join('\n') || '[Empty presentation]';
  }

  /**
   * Attempt to extract readable text from legacy binary Office formats (.doc, .ppt).
   * These are binary OLE2 compound documents — we extract printable strings.
   */
  private async extractLegacyOffice(filePath: string, filename: string): Promise<string> {
    const buffer = await readFile(filePath);
    // Extract runs of printable ASCII/Unicode characters (rough but serviceable)
    const text = buffer.toString('utf-8');
    const runs: string[] = [];
    let current = '';
    for (const char of text) {
      if (char >= ' ' && char <= '~' || char === '\n' || char === '\t') {
        current += char;
      } else {
        if (current.length >= 4) {
          runs.push(current.trim());
        }
        current = '';
      }
    }
    if (current.length >= 4) runs.push(current.trim());

    const result = runs.filter(r => r.length > 3).join(' ');
    if (result.length < 50) {
      return `[Could not extract meaningful text from legacy format: ${filename}]`;
    }
    return result;
  }

  /**
   * Categorize document content using LLM.
   */
  private async categorize(text: string, filename: string): Promise<string> {
    try {
      const client = getLiteLLMClient();
      const model = await this.getModel();
      const truncatedText = text.slice(0, 3000);

      const messages: AgentMessage[] = [
        {
          role: 'system',
          content: `You are a document classifier. Classify the document into exactly one of these categories: ${CATEGORIES.join(', ')}. Respond with ONLY the category name, nothing else.`,
          timestamp: new Date(),
        },
        {
          role: 'user',
          content: `Filename: ${filename}\n\nContent:\n${truncatedText}`,
          timestamp: new Date(),
        },
      ];

      const result = await client.complete({
        model,
        messages,
        temperature: 0.1,
        maxTokens: 20,
        extraBody: { think: false },
      });

      const category = result.content.trim().toLowerCase();
      if (CATEGORIES.includes(category as typeof CATEGORIES[number])) {
        return category;
      }

      // Try to find a matching category in the response
      for (const cat of CATEGORIES) {
        if (category.includes(cat)) {
          return cat;
        }
      }

      return 'other';
    } catch (err) {
      this.logger.warn({ err }, 'Categorization failed, defaulting to "other"');
      return 'other';
    }
  }

  /**
   * Move file from uncategorized/ to the category/ folder.
   */
  private async moveToCategory(currentPath: string, category: string): Promise<string> {
    const dir = dirname(dirname(currentPath)); // go up from uncategorized/
    const categoryDir = join(dir, category);
    const newPath = join(categoryDir, basename(currentPath));

    if (!existsSync(categoryDir)) {
      await mkdir(categoryDir, { recursive: true });
    }

    try {
      await rename(currentPath, newPath);
      return newPath;
    } catch {
      // If rename fails (e.g. cross-device), keep the original path
      this.logger.warn({ currentPath, newPath }, 'Failed to move file to category folder');
      return currentPath;
    }
  }

  /**
   * Summarize the document content using LLM.
   */
  private async summarize(text: string, filename: string): Promise<string> {
    try {
      const client = getLiteLLMClient();
      const model = await this.getModel();
      const truncatedText = text.slice(0, 6000);

      const messages: AgentMessage[] = [
        {
          role: 'system',
          content: 'You are a document summarizer. Provide a concise 2-4 sentence summary of the document content. Focus on the key information, purpose, and any important details.',
          timestamp: new Date(),
        },
        {
          role: 'user',
          content: `Filename: ${filename}\n\nContent:\n${truncatedText}`,
          timestamp: new Date(),
        },
      ];

      const result = await client.complete({
        model,
        messages,
        temperature: 0.3,
        maxTokens: 200,
        extraBody: { think: false },
      });

      return result.content.trim();
    } catch (err) {
      this.logger.warn({ err }, 'Summarization failed');
      return '';
    }
  }

  /**
   * Index document text into the knowledge base.
   */
  private async indexDocument(documentId: string, text: string, filename: string, category: string): Promise<void> {
    try {
      const service = getEmbeddingService();
      await service.indexText('document', `doc:${documentId}`, text, {
        filePath: filename,
      });
    } catch (err) {
      this.logger.warn({ err, documentId }, 'Knowledge indexing failed — document still saved');
    }
  }

  /**
   * Get the default model ID for LLM calls.
   */
  private async getModel(): Promise<string> {
    const registry = getModelRegistry();
    const defaultModel = await registry.getDefaultModel();
    return defaultModel?.modelId || 'qwen3:14b';
  }
}

export const documentProcessor = new DocumentProcessor();
