import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { writeFile, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { documentProcessor } from './processor';

// Structural cast — exposes private methods for unit-level coverage.
// Standalone interface (not extending DocumentProcessor) so the access
// modifier on the class doesn't collapse the intersection.
interface Internal {
  extractStructured(filePath: string, filename: string, mimeType: string): Promise<string>;
  extractExcel(filePath: string): Promise<string>;
}
const internal = documentProcessor as unknown as Internal;

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'octipus-doc-test-'));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('extractStructured dispatch', () => {
  test('rejects legacy .ppt with explicit conversion guidance', async () => {
    await expect(
      internal.extractStructured('/nonexistent.ppt', 'deck.ppt', 'application/vnd.ms-powerpoint'),
    ).rejects.toThrow(/Legacy \.ppt binary format is not supported/);
  });

  test('rejects unsupported structured format with filename + mime', async () => {
    await expect(
      internal.extractStructured('/nonexistent.xyz', 'thing.xyz', 'application/x-zzz'),
    ).rejects.toThrow(/Unsupported structured format: thing\.xyz/);
  });

  test('does not silently fall back to text-read on extractor failure', async () => {
    // Pass a path that won't open; mammoth must throw and the dispatcher
    // must NOT mask it as plain text content.
    await expect(
      internal.extractStructured('/nonexistent-file.docx', 'thing.docx', ''),
    ).rejects.toThrow();
  });
});

describe('extractExcel', () => {
  test('produces a markdown table per sheet with header + separator + rows', async () => {
    const XLSX = await import('xlsx');
    const wb = XLSX.utils.book_new();
    const sheet1 = XLSX.utils.aoa_to_sheet([
      ['Name', 'Age', 'City'],
      ['Alice', 30, 'Berlin'],
      ['Bob', 25, 'Paris'],
    ]);
    XLSX.utils.book_append_sheet(wb, sheet1, 'People');
    const sheet2 = XLSX.utils.aoa_to_sheet([
      ['Product', 'Price'],
      ['Widget', 9.99],
    ]);
    XLSX.utils.book_append_sheet(wb, sheet2, 'Catalog');

    const path = join(workDir, 'sample.xlsx');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    await writeFile(path, buf);

    const md = await internal.extractExcel(path);

    expect(md).toContain('## Sheet: People');
    expect(md).toContain('## Sheet: Catalog');
    expect(md).toContain('| Name | Age | City |');
    expect(md).toContain('| --- | --- | --- |');
    expect(md).toContain('| Alice | 30 | Berlin |');
    expect(md).toContain('| Bob | 25 | Paris |');
    expect(md).toContain('| Product | Price |');
    expect(md).toContain('| Widget | 9.99 |');
  });

  test('escapes pipe characters in cell values', async () => {
    const XLSX = await import('xlsx');
    const wb = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
      ['Key', 'Value'],
      ['pipe', 'a|b|c'],
    ]);
    XLSX.utils.book_append_sheet(wb, sheet, 'S');

    const path = join(workDir, 'pipes.xlsx');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    await writeFile(path, buf);

    const md = await internal.extractExcel(path);
    expect(md).toContain('| pipe | a\\|b\\|c |');
  });

  test('throws when workbook has no readable rows', async () => {
    const XLSX = await import('xlsx');
    const wb = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([]);
    XLSX.utils.book_append_sheet(wb, sheet, 'Empty');

    const path = join(workDir, 'empty.xlsx');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    await writeFile(path, buf);

    await expect(internal.extractExcel(path)).rejects.toThrow(/contains no readable data/);
  });
});
