import { readFile, mkdir, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, dirname, basename, join } from 'path';
import { documentRepository } from '@/db/repositories/document-repository';
import { getEmbeddingService } from '@/core/rag/embeddings';
import { getLiteLLMClient } from '@/models/litellm-client';
import { getModelRegistry } from '@/models/model-registry';
import { getConfig } from '@/config';
import { coreLogger } from '@/utils/logger';
import type { AgentMessage } from '@/core/types';

const IMAGE_MIME_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/tiff', 'image/bmp', 'image/webp',
]);

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.csv', '.json', '.xml', '.yaml', '.yml', '.log', '.ini', '.conf', '.toml',
  '.html', '.htm', '.css', '.js', '.ts', '.py', '.sh', '.bash', '.sql', '.env',
]);

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

      // Step 2: Extract text content
      let extractedText: string;
      if (IMAGE_MIME_TYPES.has(doc.mimeType)) {
        extractedText = await this.ocrImage(doc.storagePath);
      } else if (doc.mimeType === 'application/pdf') {
        extractedText = await this.extractPdfText(doc.storagePath);
      } else if (this.isTextFile(doc.originalName)) {
        extractedText = await this.readTextFile(doc.storagePath);
      } else {
        // Attempt to read as text for unknown types
        extractedText = await this.readTextFile(doc.storagePath);
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
   * Check if a file is a text file based on extension.
   */
  private isTextFile(filename: string): boolean {
    const ext = filename.toLowerCase().replace(/^.*(\.[^.]+)$/, '$1');
    return TEXT_EXTENSIONS.has(ext);
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
