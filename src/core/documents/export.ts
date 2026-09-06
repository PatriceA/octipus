/**
 * Writing a deliverable out as a Word document or a spreadsheet.
 *
 * The document processor reads docx / xlsx / pptx; nothing wrote them, so a
 * report an agent produced could only leave as markdown. This closes that.
 *
 * `xlsx` (SheetJS) is already a dependency and writes spreadsheets, so the
 * table path uses it. For Word there is no writer in the tree, and rather than
 * add one, this builds the OOXML package directly on `jszip` — also already a
 * dependency, and already used to read pptx speaker notes. A .docx is a zip of
 * five small XML parts; the alternative was a dependency for something the
 * repo's own rule says not to add one for.
 *
 * The subset is deliberate: headings, emphasis, inline code, bullet and
 * numbered lists, block quotes, code blocks, horizontal rules and tables.
 * That is what a client deliverable is made of.
 */
import type { InlineRun, MarkdownBlock } from './markdown';
import { parseMarkdown, runsToText } from './markdown';

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export class DocumentExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentExportError';
  }
}

function xml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * One `w:r` per run, with `xml:space="preserve"` so leading and trailing
 * spaces between runs survive — without it "**bold** text" loses its gap.
 */
function renderRuns(runs: InlineRun[]): string {
  return runs
    .filter((run) => run.text.length > 0)
    .map((run) => {
      const props: string[] = [];
      if (run.bold) props.push('<w:b/>');
      if (run.italic) props.push('<w:i/>');
      if (run.code) props.push('<w:rStyle w:val="CodeChar"/>');
      const rPr = props.length > 0 ? `<w:rPr>${props.join('')}</w:rPr>` : '';
      return `<w:r>${rPr}<w:t xml:space="preserve">${xml(run.text)}</w:t></w:r>`;
    })
    .join('');
}

function paragraph(runs: InlineRun[], style?: string, extraPr = ''): string {
  const pStyle = style ? `<w:pStyle w:val="${style}"/>` : '';
  const pPr = pStyle || extraPr ? `<w:pPr>${pStyle}${extraPr}</w:pPr>` : '';
  return `<w:p>${pPr}${renderRuns(runs)}</w:p>`;
}

/** A code block keeps its line breaks, which in OOXML are explicit `w:br`. */
function codeBlock(text: string): string {
  const lines = text.split('\n');
  const runs = lines
    .map((line, i) => `${i > 0 ? '<w:br/>' : ''}<w:t xml:space="preserve">${xml(line)}</w:t>`)
    .join('');
  return `<w:p><w:pPr><w:pStyle w:val="CodeBlock"/></w:pPr><w:r>${runs}</w:r></w:p>`;
}

function tableCell(runs: InlineRun[], header: boolean): string {
  const styled = header ? runs.map((r) => ({ ...r, bold: true })) : runs;
  return `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${paragraph(styled, 'TableText')}</w:tc>`;
}

function table(block: Extract<MarkdownBlock, { kind: 'table' }>): string {
  const width = block.header.length;
  const grid = Array.from({ length: width }, () => '<w:gridCol w:w="1000"/>').join('');
  const head = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${block.header.map((c) => tableCell(c, true)).join('')}</w:tr>`;
  const body = block.rows
    .map((row) => `<w:tr>${row.map((c) => tableCell(c, false)).join('')}</w:tr>`)
    .join('');
  const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`)
    .join('');
  return (
    `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/>` +
    `<w:tblBorders>${borders}</w:tblBorders></w:tblPr>` +
    `<w:tblGrid>${grid}</w:tblGrid>${head}${body}</w:tbl>` +
    // Word requires a paragraph after a table; two adjacent tables also need
    // one between them or they merge into one.
    '<w:p/>'
  );
}

function renderBlock(block: MarkdownBlock): string {
  switch (block.kind) {
    case 'heading':
      return paragraph(block.runs, `Heading${Math.min(block.level, 6)}`);
    case 'paragraph':
      return paragraph(block.runs);
    case 'quote':
      return paragraph(block.runs, 'Quote');
    case 'code':
      return codeBlock(block.text);
    case 'rule':
      return '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BFBFBF"/></w:pBdr></w:pPr></w:p>';
    case 'list':
      return block.items
        .map((item) => {
          const numId = block.ordered ? 2 : 1;
          const numPr = `<w:numPr><w:ilvl w:val="${item.level}"/><w:numId w:val="${numId}"/></w:numPr>`;
          return paragraph(item.runs, 'ListParagraph', numPr);
        })
        .join('');
    case 'table':
      return table(block);
  }
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;

const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
</Relationships>`;

/** Heading sizes in half-points, so 32 renders as 16pt. */
const HEADING_SIZES = [32, 28, 24, 22, 20, 20];

function stylesXml(): string {
  const headings = HEADING_SIZES.map((size, i) => {
    const level = i + 1;
    return `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="${level === 1 ? 240 : 200}" w:after="120"/><w:outlineLvl w:val="${i}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr></w:style>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:style>
${headings}
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="60"/><w:contextualSpacing/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="480"/></w:pPr><w:rPr><w:i/><w:color w:val="555555"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F5F5F5"/><w:spacing w:after="120"/><w:ind w:left="240"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="20"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="TableText"><w:name w:val="Table Text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="40"/></w:pPr></w:style>
<w:style w:type="character" w:styleId="CodeChar"><w:name w:val="Code Char"/><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="20"/></w:rPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="90" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="90" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
</w:styles>`;
}

/** Five indent levels for each list flavour — deeper nesting is folded to 4. */
function numberingXml(): string {
  const levels = (bullet: boolean) =>
    Array.from({ length: 5 }, (_, i) => {
      const fmt = bullet ? 'bullet' : ['decimal', 'lowerLetter', 'lowerRoman', 'decimal', 'lowerLetter'][i];
      const text = bullet ? ['', 'o', ''][i % 3] || '' : `%${i + 1}.`;
      const symbol = bullet ? ['•', 'o', '▪', '•', 'o'][i] : text;
      const font = bullet ? '<w:rFonts w:ascii="Symbol" w:hAnsi="Symbol" w:hint="default"/>' : '';
      return `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${xml(symbol)}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (i + 1)}" w:hanging="360"/></w:pPr><w:rPr>${font}</w:rPr></w:lvl>`;
    }).join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${levels(true)}</w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${levels(false)}</w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;
}

function corePropsXml(title: string, created: Date): string {
  const iso = created.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${xml(title)}</dc:title>
<dc:creator>Octipus</dc:creator>
<cp:lastModifiedBy>Octipus</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created>
<dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified>
</cp:coreProperties>`;
}

/**
 * Render markdown as a .docx package.
 *
 * `title` becomes the document's Word title property and, unless the markdown
 * already opens with a level-1 heading, its first heading.
 */
export async function markdownToDocx(
  markdown: string,
  options: { title: string; createdAt?: Date } = { title: 'Document' },
): Promise<Buffer> {
  const blocks = parseMarkdown(markdown);
  if (blocks.length === 0) {
    throw new DocumentExportError('Nothing to export — the markdown is empty');
  }

  const hasTitleHeading = blocks[0].kind === 'heading' && blocks[0].level === 1;
  const body = (hasTitleHeading ? blocks : [
    { kind: 'heading', level: 1, runs: [{ text: options.title }] } as MarkdownBlock,
    ...blocks,
  ]).map(renderBlock).join('');

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr></w:body></w:document>`;

  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.file('_rels/.rels', ROOT_RELS);
  zip.file('word/_rels/document.xml.rels', DOCUMENT_RELS);
  zip.file('word/document.xml', document);
  zip.file('word/styles.xml', stylesXml());
  zip.file('word/numbering.xml', numberingXml());
  zip.file('docProps/core.xml', corePropsXml(options.title, options.createdAt ?? new Date()));

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

export interface SheetData {
  name: string;
  rows: unknown[][];
}

/** Excel forbids these in a sheet name, and caps the name at 31 characters. */
export function sheetName(raw: string, taken: Set<string>): string {
  let name = (raw || 'Sheet').replace(/[[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31);
  if (name.length === 0) name = 'Sheet';
  let candidate = name;
  let n = 2;
  while (taken.has(candidate.toLowerCase())) {
    const suffix = ` (${n})`;
    candidate = `${name.slice(0, 31 - suffix.length)}${suffix}`;
    n++;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

/**
 * A cell that looks like a number becomes one, so the spreadsheet can be
 * summed. Anything else stays text — a phone number with a leading zero must
 * not silently lose it, so only an unambiguous decimal converts.
 */
function cellValue(text: string): string | number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return '';
  if (!/^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(trimmed)) return text;
  if (/^[+-]?0\d/.test(trimmed)) return text;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : text;
}

/** Every markdown table in the document, as one sheet each. */
export function markdownToSheets(markdown: string): SheetData[] {
  const blocks = parseMarkdown(markdown);
  const taken = new Set<string>();
  const sheets: SheetData[] = [];
  let index = 0;

  for (const block of blocks) {
    if (block.kind !== 'table') continue;
    index++;
    const rows: unknown[][] = [
      block.header.map((cell) => runsToText(cell)),
      ...block.rows.map((row) => row.map((cell) => cellValue(runsToText(cell)))),
    ];
    sheets.push({ name: sheetName(block.caption ?? `Table ${index}`, taken), rows });
  }

  return sheets;
}

/** Write sheets as an .xlsx workbook. */
export async function sheetsToXlsx(sheets: SheetData[]): Promise<Buffer> {
  if (sheets.length === 0) {
    throw new DocumentExportError(
      'Nothing to export — an xlsx export needs at least one markdown table (a | header | row | followed by a | --- | row)',
    );
  }
  const XLSX = await import('xlsx');
  const book = XLSX.utils.book_new();
  for (const sheet of sheets) {
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(sheet.rows), sheet.name);
  }
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
