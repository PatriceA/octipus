import { existsSync } from 'fs';
import { mkdir, readFile, rename, rmdir, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, dirname, extname, join } from 'path';
import { getConfig } from '@/config';
import { getEmbeddingService } from '@/core/rag/embeddings';
import type { AgentMessage } from '@/core/types';
import { documentRepository } from '@/db/repositories/document-repository';
import { getLiteLLMClient } from '@/models/litellm-client';
import { getModelRegistry } from '@/models/model-registry';
import { coreLogger } from '@/utils/logger';

// ── File type classification ─────────────────────────────────────────
// Instead of sending everything through OCR, we classify files into
// extraction strategies: direct text read, structured data parse, or OCR.

type ExtractionStrategy = 'text' | 'structured' | 'ocr';

const IMAGE_MIME_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/tiff', 'image/bmp', 'image/webp', 'image/avif',
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

/**
 * Run ImageMagick safely across platforms.
 *
 * IM v7 ships as `magick`; v6 as `convert`. On Windows, `convert.exe` ALSO names
 * the built-in FAT→NTFS converter — calling it blindly is a footgun. We probe
 * `magick -version` first, then `convert -version` (and verify the output mentions
 * ImageMagick) before invoking it on user files.
 */
let imageMagickBinary: string | null | undefined;
async function resolveImageMagick(): Promise<string | null> {
  if (imageMagickBinary !== undefined) return imageMagickBinary;
  const { spawnSync } = await import('child_process');
  for (const bin of ['magick', 'convert']) {
    try {
      const res = spawnSync(bin, ['-version'], { timeout: 3000, encoding: 'utf-8' });
      if (res.status === 0 && /ImageMagick/i.test(res.stdout || '')) {
        imageMagickBinary = bin;
        return bin;
      }
    } catch { /* not found / not executable */ }
  }
  imageMagickBinary = null;
  return null;
}

async function runImageMagick(args: string[], timeoutMs = 15000): Promise<boolean> {
  const bin = await resolveImageMagick();
  if (!bin) return false;
  const { spawnSync } = await import('child_process');
  const res = spawnSync(bin, args, { timeout: timeoutMs });
  return res.status === 0;
}

let pdftoppmAvailable: boolean | undefined;
async function hasPdftoppm(): Promise<boolean> {
  if (pdftoppmAvailable !== undefined) return pdftoppmAvailable;
  try {
    const { spawnSync } = await import('child_process');
    const res = spawnSync('pdftoppm', ['-v'], { timeout: 3000, encoding: 'utf-8' });
    // pdftoppm prints version on stderr and exits 0 or 99 depending on build
    pdftoppmAvailable = /pdftoppm/i.test(res.stderr || res.stdout || '');
  } catch {
    pdftoppmAvailable = false;
  }
  return pdftoppmAvailable;
}

/**
 * Heuristic: does OCR output look like real document text (not garbage / one-word output)?
 * Used to decide whether the follow-up vision description call is worth the cost.
 */
function isSubstantiveText(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length < 80) return false;
  const letters = (trimmed.match(/[A-Za-zÀ-ÿ]/g) || []).length;
  const wordCount = trimmed.split(/\s+/).length;
  return letters / trimmed.length > 0.5 && wordCount >= 15;
}

/** Strip OCR model grounding/reference tokens from output */
function cleanOcrOutput(text: string): string {
  return text
    .replace(/<\|ref\|>.*?<\|\/ref\|>/g, '')
    .replace(/<\|det\|>.*?<\|\/det\|>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

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
            extractedText = await this.processImage(doc.storagePath);
          }
          break;
        case 'text':
        default:
          extractedText = await this.readTextFile(doc.storagePath);
          break;
      }

      if (!extractedText || extractedText.trim().length === 0) {
        throw new Error(
          `No text could be extracted from ${doc.originalName}. ` +
            (strategy === 'ocr'
              ? 'For images/PDFs, configure a model with topic "ocr" or "vision" on the Models page; for scanned PDFs, install poppler (pdftoppm) so pages can be rendered for OCR.'
              : 'The file appears empty or unreadable.'),
        );
      }

      // Step 3: Categorize
      const category = await this.categorize(extractedText, doc.originalName, doc.userId);

      // Step 4: Summarize
      const summary = await this.summarize(extractedText, doc.originalName, doc.userId);

      // Step 5: Index into knowledge base — must succeed before we file the document away,
      // otherwise a failed doc ends up in the wrong category folder with no knowledge entry.
      // Image-strategy extractions get purpose='image_description' (Phase E)
      // so retention and retrieval can distinguish vision-derived text
      // from regular document text.
      const isImageDerived = strategy === 'ocr' && doc.mimeType !== 'application/pdf';
      await this.indexDocument(
        documentId,
        extractedText,
        doc.originalName,
        category,
        isImageDerived ? 'image_description' : undefined,
      );

      // Step 6: Move file to category folder (after indexing succeeded)
      const newPath = await this.moveToCategory(doc.storagePath, category);

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
   * Prepare an image file for vision model processing: read, convert if needed, return base64 + mime.
   */
  private async prepareImage(filePath: string): Promise<{ base64: string; mimeType: string }> {
    let fileBuffer = await readFile(filePath);
    const ext = extname(filePath).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.webp': 'image/webp', '.tiff': 'image/tiff', '.bmp': 'image/bmp',
      '.avif': 'image/avif', '.heic': 'image/heic', '.heif': 'image/heif',
    };
    let mimeType = mimeMap[ext] || 'image/png';

    // Convert non-PNG/JPEG formats to PNG for universal vision model compatibility
    const nativeExts = new Set(['.png', '.jpg', '.jpeg']);
    if (!nativeExts.has(ext)) {
      const tmpOut = join(tmpdir(), `ocr-convert-${Date.now()}.png`);
      const converted = await runImageMagick([filePath, tmpOut]);
      if (converted) {
        try {
          fileBuffer = await readFile(tmpOut);
          mimeType = 'image/png';
          this.logger.info({ from: ext, filePath }, 'Converted image to PNG');
        } catch (err) {
          this.logger.warn({ err, ext, tmpOut }, 'Image conversion produced no output, sending original format');
        } finally {
          await unlink(tmpOut).catch(() => undefined);
        }
      } else {
        this.logger.warn({ ext, filePath }, 'No ImageMagick available — sending original image format to vision model');
      }
    }

    return { base64: fileBuffer.toString('base64'), mimeType };
  }

  /**
   * Process an image: run OCR (text extraction) and vision analysis (image description).
   * Uses 'ocr' topic model for text extraction, 'vision' topic model for description.
   * Combines both results so the document has both extracted text and a visual summary.
   */
  private async processImage(filePath: string): Promise<string> {
    const { base64, mimeType } = await this.prepareImage(filePath);
    const registry = getModelRegistry();
    const client = getLiteLLMClient();
    const parts: string[] = [];
    let ocrYieldedText = false;

    // 1. Try OCR (text extraction) with 'ocr' topic model
    const ocrModel = await registry.getModelForTopic('ocr');
    if (ocrModel) {
      try {
        this.logger.info({ model: ocrModel.modelId, filePath }, 'OCR text extraction');
        const ocrResult = await client.completeVision({
          model: ocrModel.modelId,
          prompt: '<|grounding|>Convert the document to markdown.',
          imageBase64: base64,
          mimeType,
        });
        const ocrText = cleanOcrOutput(ocrResult.content || '');
        if (isSubstantiveText(ocrText)) {
          parts.push(`[Extracted Text]\n${ocrText}`);
          ocrYieldedText = true;
        } else if (ocrText && ocrText.length > 5) {
          // Keep partial OCR output but still run vision to compensate
          parts.push(`[Extracted Text]\n${ocrText}`);
        }
      } catch (err) {
        this.logger.warn({ err, model: ocrModel.modelId }, 'OCR extraction failed');
      }
    }

    // 2. Vision analysis (image description) with 'vision' topic model.
    // Skip when OCR already produced substantive text — running both doubles cost for documents.
    const visionModel = await registry.getModelForTopic('vision');
    if (visionModel && !ocrYieldedText) {
      try {
        this.logger.info({ model: visionModel.modelId, filePath }, 'Vision image analysis');
        const visionResult = await client.completeVision({
          model: visionModel.modelId,
          prompt: 'Describe this image in detail. What does it show? Include all visible details, objects, text, colors, and layout.',
          imageBase64: base64,
          mimeType,
        });
        const description = visionResult.content?.trim();
        if (description) {
          parts.push(`[Image Description]\n${description}`);
        }
      } catch (err) {
        this.logger.warn({ err, model: visionModel.modelId }, 'Vision analysis failed');
      }
    } else if (visionModel && ocrYieldedText) {
      this.logger.info({ model: visionModel.modelId, filePath }, 'Skipping vision analysis — OCR already yielded substantive text');
    }

    // 3. If neither model is configured, try a single call with whatever is available
    if (parts.length === 0) {
      const fallbackModel = ocrModel || visionModel;
      if (fallbackModel) {
        const result = await client.completeVision({
          model: fallbackModel.modelId,
          prompt: 'Describe this image and extract any text content.',
          imageBase64: base64,
          mimeType,
        });
        return result.content || '';
      }

      // Last resort: direct Ollama API — only if explicitly configured
      const config = getConfig();
      const ocrEndpoint = config.workspace.ocrEndpoint;
      const ocrFallback = config.workspace.ocrModel;
      if (ocrEndpoint && ocrFallback) {
        this.logger.warn({ model: ocrFallback, ocrEndpoint }, 'No ocr/vision model in registry, falling back to direct OCR endpoint');

        const response = await fetch(`${ocrEndpoint}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: ocrFallback,
            prompt: '<|grounding|>Convert the document to markdown.',
            images: [base64],
            stream: false,
          }),
        });

        if (!response.ok) {
          throw new Error(`OCR request failed: ${response.status} ${response.statusText}`);
        }

        const data = await response.json() as { response: string };
        return data.response || '';
      }

      throw new Error('No vision or OCR model configured. Assign a model with the "ocr" or "vision" topic in the Models page.');
    }

    return parts.join('\n\n');
  }

  /**
   * Extract text from a PDF using pdftotext (poppler).
   * Falls back to page-by-page OCR via pdftoppm + vision model for image-based PDFs.
   */
  private async extractPdfText(filePath: string): Promise<string> {
    // 1. Try pdfjs-dist for text extraction (no external tools needed)
    try {
      const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const pdf = await pdfjsLib.getDocument(filePath).promise;
      const pageTexts: string[] = [];

      const maxPages = Math.min(pdf.numPages, 50);
      for (let i = 1; i <= maxPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        const text = content.items.map((item: any) => item.str).join(' ');
        if (text.trim()) pageTexts.push(text);
      }

      const fullText = pageTexts.join('\n\n').trim();
      if (fullText.length > 50) {
        this.logger.info({ filePath, textLength: fullText.length, pages: maxPages }, 'PDF text extracted via pdfjs');
        return fullText;
      }
    } catch (err) {
      this.logger.warn({ err, filePath }, 'pdfjs extraction failed, trying pdftotext');
    }

    // 2. Fallback: pdftotext (if installed)
    try {
      const { spawnSync } = await import('child_process');
      const result = spawnSync('pdftotext', ['-layout', '-enc', 'UTF-8', filePath, '-'], {
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024,
      });
      const text = (result.stdout?.toString('utf-8') || '').trim();

      if (text.length > 50) {
        this.logger.info({ filePath, textLength: text.length }, 'PDF text extracted via pdftotext');
        return text;
      }
    } catch (err) {
      this.logger.warn({ err, filePath }, 'pdftotext also failed');
    }

    // 3. Image-based PDF — render each page to PNG via pdftoppm, send to vision model
    const registry = getModelRegistry();
    const ocrModel = await registry.getModelForTopic('ocr');
    const visionModel = !ocrModel ? await registry.getModelForTopic('vision') : null;
    const model = ocrModel || visionModel;

    if (!model) {
      throw new Error(
        'Scanned/image-only PDF detected, but no OCR/vision model is configured. ' +
          'Assign a model to topic "ocr" or "vision" on the Models page.',
      );
    }

    if (!(await hasPdftoppm())) {
      throw new Error(
        'Scanned/image-only PDF detected, but pdftoppm is not installed. ' +
          'Install poppler (e.g. `choco install poppler` on Windows, `brew install poppler` on macOS, ' +
          '`apt-get install poppler-utils` on Linux) so pages can be rendered for OCR.',
      );
    }

    return this.ocrPdfWithPdftoppm(filePath, model.modelId, ocrModel ? 'ocr' : 'vision');
  }

  /**
   * Render PDF pages to PNGs with pdftoppm, then OCR each via the vision model.
   * Capped at 20 pages to avoid runaway costs on long scanned PDFs.
   */
  private async ocrPdfWithPdftoppm(filePath: string, modelId: string, topic: 'ocr' | 'vision'): Promise<string> {
    const { spawnSync } = await import('child_process');
    const { readdir } = await import('fs/promises');
    const workDir = join(tmpdir(), `pdf-ocr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await mkdir(workDir, { recursive: true });
    const prefix = join(workDir, 'page');

    const MAX_PAGES = 20;
    try {
      const render = spawnSync(
        'pdftoppm',
        ['-png', '-r', '200', '-l', String(MAX_PAGES), filePath, prefix],
        { timeout: 120_000 },
      );
      if (render.status !== 0) {
        throw new Error(`pdftoppm failed with status ${render.status}: ${render.stderr?.toString() || 'unknown'}`);
      }

      const files = (await readdir(workDir))
        .filter(f => f.startsWith('page') && f.endsWith('.png'))
        .sort();

      if (files.length === 0) {
        throw new Error('pdftoppm produced no output files');
      }

      this.logger.info({ filePath, pages: files.length, model: modelId, topic }, 'OCR-ing PDF pages via pdftoppm');

      const client = getLiteLLMClient();
      const pageTexts: string[] = [];
      const prompt = topic === 'ocr'
        ? '<|grounding|>Convert the document to markdown.'
        : 'Transcribe all text from this document page. Preserve layout where reasonable.';

      for (let i = 0; i < files.length; i++) {
        try {
          const pngPath = join(workDir, files[i]);
          const pngBuffer = await readFile(pngPath);
          const result = await client.completeVision({
            model: modelId,
            prompt,
            imageBase64: pngBuffer.toString('base64'),
            mimeType: 'image/png',
          });
          const pageText = cleanOcrOutput(result.content || '').trim();
          if (pageText.length > 5) {
            pageTexts.push(`--- Page ${i + 1} ---\n${pageText}`);
          }
        } catch (pageErr) {
          this.logger.warn({ err: pageErr, page: i + 1 }, 'OCR failed for PDF page');
        }
      }

      if (pageTexts.length === 0) {
        throw new Error(`Vision model "${modelId}" returned no text for any of the ${files.length} rendered page(s)`);
      }
      return pageTexts.join('\n\n');
    } finally {
      // Best-effort cleanup
      try {
        const files = await readdir(workDir);
        await Promise.all(files.map(f => unlink(join(workDir, f)).catch(() => undefined)));
        await rmdir(workDir).catch(() => undefined);
      } catch { /* ignore */ }
    }
  }

  /**
   * Read a text file directly.
   */
  private async readTextFile(filePath: string): Promise<string> {
    const buffer = await readFile(filePath, 'utf-8');
    return buffer;
  }

  /**
   * Extract content from structured documents (Word, Excel, PowerPoint).
   * Uses dedicated libraries per format. Fails loud — no silent fallback to
   * binary-as-text read, which would feed garbage to the categorizer/embedder.
   */
  private async extractStructured(filePath: string, filename: string, mimeType: string): Promise<string> {
    const ext = extname(filename).toLowerCase();

    if (ext === '.ppt') {
      throw new Error(
        'Legacy .ppt binary format is not supported. Convert the file to .pptx and re-upload.',
      );
    }
    if (ext === '.doc') {
      return this.extractDocLegacy(filePath);
    }
    if (ext === '.docx' || mimeType.includes('wordprocessing')) {
      return this.extractDocx(filePath);
    }
    if (ext === '.xlsx' || ext === '.xls' || mimeType.includes('spreadsheet') || mimeType.includes('excel')) {
      return this.extractExcel(filePath);
    }
    if (ext === '.pptx' || mimeType.includes('presentation') || mimeType.includes('powerpoint')) {
      return this.extractPptx(filePath);
    }

    throw new Error(`Unsupported structured format: ${filename} (mime=${mimeType || 'unknown'})`);
  }

  /**
   * Extract data from spreadsheets (.xlsx / .xls / .xlsm) via SheetJS.
   * Emits one markdown section per sheet so the markdown chunker can
   * scope chunks to a sheet and the embedder sees real structure.
   */
  private async extractExcel(filePath: string): Promise<string> {
    const XLSX = await import('xlsx');
    const buffer = await readFile(filePath);
    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });

    const sections: string[] = [];
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet) continue;
      const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
        header: 1,
        blankrows: false,
        defval: '',
      });
      if (rows.length === 0) continue;

      const maxCols = Math.max(...rows.map(r => (Array.isArray(r) ? r.length : 0)));
      if (maxCols === 0) continue;

      const renderCell = (v: unknown): string => {
        if (v === undefined || v === null || v === '') return '';
        if (v instanceof Date) return v.toISOString();
        return String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ');
      };

      sections.push(`## Sheet: ${sheetName}`);
      sections.push('');

      const header = rows[0] as unknown[];
      const headerCells = Array.from({ length: maxCols }, (_, i) => {
        const raw = renderCell(header[i]);
        return raw || `Col${i + 1}`;
      });
      sections.push(`| ${headerCells.join(' | ')} |`);
      sections.push(`| ${Array.from({ length: maxCols }, () => '---').join(' | ')} |`);

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i] as unknown[];
        const cells = Array.from({ length: maxCols }, (_, j) => renderCell(row[j]));
        sections.push(`| ${cells.join(' | ')} |`);
      }
      sections.push('');
    }

    const result = sections.join('\n').trim();
    if (!result) {
      throw new Error(`Spreadsheet ${filePath} contains no readable data`);
    }
    return result;
  }

  /**
   * Extract text from Word (.docx) via mammoth.
   * Returns markdown so headings, lists, tables, and footnotes survive
   * into the chunker (which understands ATX headings).
   */
  private async extractDocx(filePath: string): Promise<string> {
    const mammoth = await import('mammoth');
    const result = await mammoth.convertToMarkdown({ path: filePath });
    for (const msg of result.messages) {
      if (msg.type === 'error') {
        this.logger.warn({ filePath, message: msg.message }, 'mammoth conversion error');
      } else {
        this.logger.debug({ filePath, message: msg.message }, 'mammoth conversion warning');
      }
    }
    const text = result.value.trim();
    if (!text) {
      throw new Error(`mammoth produced no text for ${filePath}`);
    }
    return text;
  }

  /**
   * Extract text from PowerPoint (.pptx) via node-pptx-parser.
   * Speaker notes aren't exposed by the lib — we read notesSlideN.xml
   * directly via jszip and append per-slide.
   */
  private async extractPptx(filePath: string): Promise<string> {
    const { default: PptxParser } = await import('node-pptx-parser');
    const parser = new PptxParser(filePath);
    const slides = await parser.extractText();
    const notes = await this.extractPptxNotes(filePath);

    const sections: string[] = [];
    slides.forEach((slide, idx) => {
      const slideNum = idx + 1;
      sections.push(`## Slide ${slideNum}`);
      sections.push('');
      const body = slide.text.map(t => t.trim()).filter(Boolean).join('\n\n');
      if (body) sections.push(body);
      const note = notes.get(slideNum);
      if (note) {
        sections.push('');
        sections.push(`**Notes:** ${note}`);
      }
      sections.push('');
    });

    const result = sections.join('\n').trim();
    if (!result) {
      throw new Error(`No text extracted from presentation ${filePath}`);
    }
    return result;
  }

  /**
   * Read speaker notes from a pptx by scanning ppt/notesSlides/notesSlideN.xml.
   * Returns a map of slide number → notes text. Slides without notes are absent.
   */
  private async extractPptxNotes(filePath: string): Promise<Map<number, string>> {
    const jszip = await import('jszip');
    const JSZip = (jszip as any).default || jszip;
    const buffer = await readFile(filePath);
    const zip = await JSZip.loadAsync(buffer);
    const notes = new Map<number, string>();

    const noteFiles = Object.keys(zip.files).filter(f =>
      /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(f),
    );
    for (const file of noteFiles) {
      const match = file.match(/notesSlide(\d+)\.xml$/);
      if (!match) continue;
      const slideNum = parseInt(match[1], 10);
      const xml = await zip.file(file)!.async('text');
      const texts: string[] = [];
      for (const m of xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)) {
        const trimmed = m[1].trim();
        // Drop slide-number placeholders that PowerPoint stamps into notes
        if (trimmed && !/^\d+$/.test(trimmed)) texts.push(trimmed);
      }
      if (texts.length > 0) notes.set(slideNum, texts.join(' '));
    }
    return notes;
  }

  /**
   * Extract text from legacy Word (.doc, OLE2 binary) via word-extractor.
   * Includes body, footnotes, and endnotes. Legacy .ppt is not supported —
   * handled by extractStructured() with a fail-loud error.
   */
  private async extractDocLegacy(filePath: string): Promise<string> {
    const mod = await import('word-extractor');
    const WordExtractor = (mod as any).default || mod;
    const extractor = new WordExtractor();
    const doc = await extractor.extract(filePath);

    const parts = [doc.getBody(), doc.getFootnotes(), doc.getEndnotes()]
      .map((s: string) => (s ? s.trim() : ''))
      .filter(Boolean);

    const text = parts.join('\n\n').trim();
    if (text.length < 10) {
      throw new Error(`word-extractor produced no meaningful text for ${filePath}`);
    }
    return text;
  }

  /**
   * Categorize document content using LLM.
   */
  private async categorize(text: string, filename: string, userId: string): Promise<string> {
    try {
      const client = getLiteLLMClient();
      const model = await this.getModel();
      this.logger.info({ model, filename }, 'Categorizing document');
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
        userId,
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
  private async summarize(text: string, filename: string, userId: string): Promise<string> {
    try {
      const client = getLiteLLMClient();
      const model = await this.getModel();
      this.logger.info({ model, filename }, 'Summarizing document');
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
        userId,
      });

      return result.content.trim();
    } catch (err) {
      this.logger.warn({ err }, 'Summarization failed');
      return '';
    }
  }

  /**
   * Index document text into the knowledge base.
   *
   * Throws on failure — the caller (process()) turns that into a 'failed'
   * status on the document row so the user sees it in the UI. Previously
   * this swallowed the error and the document was marked 'completed' with
   * nothing in the knowledge base.
   */
  private async indexDocument(
    documentId: string,
    text: string,
    filename: string,
    _category: string,
    purpose?: 'image_description',
  ): Promise<void> {
    const service = getEmbeddingService();
    const embeddingModel = (await getModelRegistry().getModelForTopic('embedding'))?.modelId ?? null;
    this.logger.info({ documentId, filename, model: embeddingModel, purpose: purpose ?? 'document' }, 'Indexing document into knowledge base');
    try {
      // Phase E: image-derived rows are tagged 'image_description' so
      // retention/retrieval can treat them distinctly; everything else
      // is a regular document chunk. Document id is passed so the
      // structural chunker can populate embeddings.doc_id for
      // hierarchy walks and per-document scoping.
      const stored = await service.indexText(
        purpose ?? 'document',
        `doc:${documentId}`,
        text,
        { filePath: filename },
        documentId,
      );
      this.logger.info({ documentId, filename, model: embeddingModel, chunksStored: stored }, 'Document indexed into knowledge base');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      this.logger.error(
        { err, message, stack, documentId, filename, purpose: purpose ?? 'document' },
        'Knowledge indexing failed — document will be marked as failed',
      );
      throw err;
    }
  }

  /**
   * Get the default model ID for LLM calls.
   */
  private async getModel(): Promise<string> {
    const registry = getModelRegistry();
    const defaultModel = await registry.getDefaultModel();
    if (!defaultModel) {
      throw new Error('No default model configured for document processing. Set one in the Models page.');
    }
    return defaultModel.modelId;
  }
}

export const documentProcessor = new DocumentProcessor();
