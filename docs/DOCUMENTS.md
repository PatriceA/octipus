# Document Management

## Overview

The document management system handles file uploads, text extraction (OCR), LLM-powered categorization and summarization, and automatic indexing into the knowledge base. Documents can be uploaded via the WebUI, REST API, or as attachments from messaging channels (Telegram, Slack, WhatsApp, Teams).

## Processing Pipeline

Every uploaded document flows through a 7-step pipeline:

```
Upload --> Queue --> Extract Text --> Categorize --> Move to Category Folder --> Summarize --> Index to Knowledge Base
```

1. **Upload** -- File saved to `workspace/documents/uncategorized/` with a UUID filename
2. **Queue** -- Document enqueued for sequential processing (concurrency=1)
3. **Classify file type** -- Determine extraction strategy based on MIME type and extension (see below)
4. **Extract text** -- Strategy-specific: direct read, structured parse, or OCR
5. **Categorize** -- LLM analyzes extracted text and assigns a category
6. **Move** -- File moved from `uncategorized/` to `workspace/documents/{category}/`
7. **Summarize** -- LLM generates a concise summary of the content
8. **Index** -- Extracted text indexed into the knowledge base (embeddings table) for RAG search

## Upload Sources

### WebUI
Upload via the Documents page (`/documents`). Supports drag-and-drop and multi-file upload using `FormData` to `POST /api/documents/upload`.

### REST API
```bash
curl -X POST http://localhost:3005/api/documents/upload \
  -H "Authorization: Bearer <token>" \
  -F "files=@invoice.pdf" \
  -F "files=@receipt.jpg"
```

### Messaging Channels
File attachments from Telegram, Slack, WhatsApp, and Teams are automatically downloaded and enqueued for processing via the `AttachmentHandler`. Processable MIME types include images (PNG, JPEG, TIFF, BMP, WebP), PDFs, Office documents (Word, Excel), and text files.

## Exporting a deliverable

Reading docx / xlsx / pptx has always worked; nothing wrote them, so an agent's
report could only leave as markdown. `documents.export_document` closes that:

```
export_document { title, markdown, format: "docx" | "xlsx", summary? }
  → { documentId, filename, mimeType, size, downloadUrl, format }
```

- **docx** carries headings, bold / italic / inline code, bullet and numbered
  lists (real Word numbering, not bullet characters), block quotes, code
  blocks, horizontal rules and tables. If the markdown does not open with a
  level-1 heading, `title` becomes one.
- **xlsx** makes one sheet per markdown table, named after the heading above
  it. Cells that are unambiguously numeric become numbers so the sheet can be
  summed; a value with a leading zero stays text so a phone number survives.
  Markdown with no table is an error naming what is missing, not an empty
  workbook.

The file lands in the user's Documents under the `Exports` category as a
`completed` row — deliberately not enqueued for processing, since the OCR
queue exists to extract text from what a human uploaded and running it over
our own output would only re-derive what we already had. It is fetched at
`GET /api/documents/:id/raw?download=1`, which is the `downloadUrl` the tool
returns.

No new dependency: xlsx is written with SheetJS (already used to read
spreadsheets) and the docx package is built directly on `jszip` (already used
to read pptx speaker notes). A `.docx` is a zip of five small XML parts, and
the repo's rule is not to add a library for something it can already do. The
tests verify the output by reading it back with `mammoth` — the same library
the processor uses to read Word files — so what is asserted is that a real
Word reader can open it.

The `documents` group is held by the `writing`, `research`, `data` and
`general` roles.

### Agent Tool
Agents with the `documents` tool can list, view, and search uploaded documents.

## Extraction Strategies

Not every file needs OCR. The processor classifies each file and picks the most efficient extraction method:

| Strategy | When Used | Method |
|----------|-----------|--------|
| **`text`** | Plain text, code, config, markup files | Direct file read — no model calls needed |
| **`structured`** | Office documents (Word, Excel, PowerPoint) | Dedicated parser per format (mammoth / SheetJS / node-pptx-parser / word-extractor) |
| **`ocr`** | Images and PDFs | Vision model (`glm-ocr`) via Ollama |

### Text — Direct Read

Files that are already human-readable text are read directly with no model involvement.

| Extensions |
|-----------|
| `.txt`, `.md`, `.csv`, `.json`, `.xml`, `.yaml`, `.yml` |
| `.log`, `.ini`, `.conf`, `.toml`, `.env` |
| `.html`, `.htm`, `.css`, `.js`, `.ts`, `.py`, `.sh`, `.bash`, `.sql` |

### Structured — Office Document Parsing

Each supported Office format has a dedicated pure-JS parser. Output is markdown where possible so the markdown chunker (`src/core/rag/markdown-chunker.ts`) builds sectioned chunks rather than one flat blob. No LLM or OCR involvement.

| Format | Extension | MIME Type | Parser | Output |
|--------|-----------|-----------|--------|--------|
| Word | `.docx` | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | `mammoth` | Markdown — headings, lists, tables, footnotes preserved |
| Word (legacy) | `.doc` | `application/msword` | `word-extractor` | Plain text — body + footnotes + endnotes |
| Excel | `.xlsx`, `.xlsm` | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` | `xlsx` (SheetJS) | Markdown table per sheet |
| Excel (legacy) | `.xls` | `application/vnd.ms-excel` | `xlsx` (SheetJS) | Markdown table per sheet |
| PowerPoint | `.pptx` | `application/vnd.openxmlformats-officedocument.presentationml.presentation` | `node-pptx-parser` + jszip for notes | Markdown — `## Slide N` sections with speaker notes |
| PowerPoint (legacy) | `.ppt` | `application/vnd.ms-powerpoint` | — | **Unsupported** — fail-loud: convert to `.pptx` and re-upload |

**Excel output example:**
```markdown
## Sheet: People

| Name | Department | Salary |
| --- | --- | --- |
| Alice | Engineering | 95000 |
| Bob | Marketing | 82000 |

## Sheet: Quarters

| Q1 | Q2 | Q3 | Q4 |
| --- | --- | --- | --- |
| 120000 | 135000 | 128000 | 142000 |
```

**PowerPoint output example:**
```markdown
## Slide 1

Q3 Roadmap

**Notes:** Open with the milestone delivered last quarter.

## Slide 2

Three pillars: scale, security, support.
```

**Failure handling.** Structured extractors fail loud — a corrupted DOCX, an unsupported `.ppt`, or an unknown structured extension surfaces as `status: 'failed'` on the document row with the underlying error message. There is no silent fallback to reading the binary as text (which historically produced garbage that still passed the categorizer).

### OCR — Vision Model

Only images and PDFs are sent to the OCR model. PDFs first attempt text extraction (checking the printable character ratio); image-heavy PDFs fall back to OCR.

| Format | Extensions | MIME Types |
|--------|-----------|-----------|
| Images | `.png`, `.jpg`, `.jpeg`, `.tiff`, `.bmp`, `.webp` | `image/png`, `image/jpeg`, `image/tiff`, `image/bmp`, `image/webp` |
| PDF | `.pdf` | `application/pdf` |

**OCR model:** `glm-ocr` via Ollama (default endpoint: `http://localhost:11435`). The image is base64-encoded and sent to the `/api/generate` endpoint with a text extraction prompt.

## Categories

Documents are categorized by LLM analysis into one of:

| Category | Description |
|----------|-------------|
| `invoices` | Bills, invoices, payment requests |
| `contracts` | Agreements, contracts, terms |
| `reports` | Reports, analyses, summaries |
| `correspondence` | Emails, letters, communications |
| `technical` | Technical docs, manuals, specs |
| `receipts` | Purchase receipts, confirmations |
| `legal` | Legal documents, compliance |
| `medical` | Medical records, prescriptions |
| `financial` | Financial statements, budgets |
| `other` | Uncategorizable documents |

## Storage

Documents are stored on the filesystem under the workspace directory:

```
workspace/documents/
├── uncategorized/      # Newly uploaded, awaiting processing
├── invoices/           # Categorized documents
├── contracts/
├── reports/
├── technical/
└── ...
```

Each file is stored with a UUID filename to avoid collisions. The original filename is preserved in the database.

## Queue System

The `DocumentQueue` processes documents sequentially (one at a time per process) and emits events for real-time tracking. The queue itself is the `background_jobs` table (`kind = 'document'`), not an in-process array: `enqueue` writes a row, the worker claims the oldest `queued` row under a row lock, and at boot the queue drains whatever a previous process left queued. A document that was mid-extraction when the process died is marked `failed` with "Interrupted by a restart" (its job `interrupted`) rather than re-run — the same rule pipelines follow. A document deleted while it was being processed closes its job as `cancelled`, which the digest does not report. Finished jobs stay for thirty days so the "while you were away" digest can report them.

| Event | Parameters | Description |
|-------|------------|-------------|
| `enqueued` | `documentId, userId` | Document added to queue |
| `processing` | `documentId, userId` | Processing started |
| `completed` | `documentId, userId` | Processing finished successfully |
| `failed` | `documentId, error, userId` | Processing failed — including an extraction the processor recorded as `failed` on the document |

Events are forwarded to WebSocket clients (filtered by userId) for real-time UI updates.

## OCR Configuration

The OCR model is only used for images and image-heavy PDFs. Office documents and text files are extracted directly without any model calls.

| Setting | Default | Description |
|---------|---------|-------------|
| `workspace.ocrEndpoint` | `http://localhost:11435` | Ollama endpoint for OCR model |
| `workspace.ocrModel` | `glm-ocr` | Vision model for text extraction |

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/documents/upload` | POST | Upload files (multipart form data) |
| `/api/documents` | GET | List documents with optional `category`, `status`, `limit` filters |
| `/api/documents/:id` | GET | Get full document details (OCR text, summary, metadata) |

## Database Schema

```sql
CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  filename TEXT NOT NULL,           -- UUID filename on disk
  original_name TEXT NOT NULL,      -- Original upload filename
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  category TEXT,                    -- LLM-assigned category
  ocr_text TEXT,                    -- Extracted text content
  summary TEXT,                     -- LLM-generated summary
  status document_status NOT NULL DEFAULT 'queued',
  storage_path TEXT NOT NULL,       -- Filesystem path
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  processed_at TIMESTAMP
);
```

Status enum: `queued` | `processing` | `completed` | `failed`

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `workspace.documentsPath` | `./workspace/documents` | Base directory for document storage |
| `workspace.maxUploadSize` | `52428800` (50MB) | Maximum file upload size in bytes |

## UI

### WebUI (`/documents`)
- Document list with category and status filters
- Upload dialog with drag-and-drop
- Queue status banner showing processing progress
- Detail modal with OCR text and summary
- Real-time status updates via WebSocket

## Key Files

| File | Purpose |
|------|---------|
| `src/core/documents/processor.ts` | DocumentProcessor -- 7-step pipeline |
| `src/core/documents/queue.ts` | DocumentQueue -- sequential processing over `background_jobs` rows, with events |
| `src/core/jobs/recover.ts` | Boot sweep: interrupts `running` jobs, repairs their documents, prunes old rows |
| `src/api/routes/documents.ts` | REST API endpoints (upload, list, detail) |
| `src/channels/attachment-handler.ts` | Channel attachment download and enqueue |
| `src/db/schema/documents.ts` | Drizzle schema |
| `src/db/repositories/document-repository.ts` | Data access layer |
| `src/tools/documents/index.ts` | Agent tool for document access |
| `web/app/documents/page.tsx` | WebUI documents page |
