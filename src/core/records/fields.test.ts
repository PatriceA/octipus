import { describe, expect, test } from 'vitest';
import { parseFields, RecordValidationError, recordTitle, validateRecordData } from './fields';

const INVOICE = parseFields([
  { key: 'number', label: 'Invoice number', type: 'text', required: true },
  { key: 'amount', label: 'Amount', type: 'money', required: true },
  { key: 'due', label: 'Due', type: 'date' },
  { key: 'paid', label: 'Paid', type: 'boolean' },
  { key: 'method', label: 'Method', type: 'select', options: ['SEPA', 'card'] },
  { key: 'contact', label: 'Contact', type: 'email' },
  { key: 'site', label: 'Site', type: 'url' },
  { key: 'phone', label: 'Phone', type: 'phone' },
  { key: 'pages', label: 'Pages', type: 'number' },
]);

function problems(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    if (err instanceof RecordValidationError) return err.problems;
    throw err;
  }
  throw new Error('expected a RecordValidationError');
}

describe('parseFields', () => {
  test('refuses bad keys, duplicates, selects without options and options without a select', () => {
    expect(problems(() => parseFields([{ key: 'Bad Key', label: 'x', type: 'text' }]))[0]).toMatch(/lower-case/);
    expect(problems(() => parseFields([{ key: 'a', label: 'A', type: 'text' }, { key: 'a', label: 'B', type: 'text' }]))).toContain('Field key "a" is used twice');
    expect(problems(() => parseFields([{ key: 's', label: 'S', type: 'select' }]))).toContain('Field "s" is a select and needs options');
    expect(problems(() => parseFields([{ key: 't', label: 'T', type: 'text', options: ['x'] }]))).toContain('Field "t" has options but is not a select');
    expect(problems(() => parseFields([{ key: 'x', label: 'X', type: 'blob' }])).length).toBeGreaterThan(0);
    expect(problems(() => parseFields([{ key: 'x', label: 'X', type: 'text', extra: 1 }])).length).toBeGreaterThan(0);
  });
});

describe('validateRecordData', () => {
  test('normalizes each type', () => {
    const data = validateRecordData(INVOICE, {
      number: ' R-1 ', amount: '12,345', due: '2030-02-28', paid: 'true', method: 'SEPA',
      contact: 'a@b.de', site: 'https://example.com', phone: '+49 30 123', pages: 3,
    });
    expect(data).toEqual({
      number: 'R-1', amount: 12.35, due: '2030-02-28', paid: true, method: 'SEPA',
      contact: 'a@b.de', site: 'https://example.com', phone: '+49 30 123', pages: 3,
    });
  });

  test('lists every problem at once, unknown keys included', () => {
    const found = problems(() => validateRecordData(INVOICE, {
      amount: 'lots', due: '2030-02-30', method: 'cash', contact: 'nope', site: 'javascript:alert(1)', typo: 1,
    }));
    expect(found).toEqual(expect.arrayContaining([
      'Unknown field "typo"',
      'Amount: must be a number',
      'Due: is not a real date',
      'Method: must be one of: SEPA, card',
      'Contact: must be an email address',
      'Site: must start with http:// or https://',
      'Invoice number: required',
    ]));
  });

  test('null and blank leave a field empty; required still holds', () => {
    expect(validateRecordData(INVOICE, { number: 'R-1', amount: 10, paid: null, due: ' ' })).toEqual({ number: 'R-1', amount: 10 });
    expect(problems(() => validateRecordData(INVOICE, { number: 'R-1', amount: '' }))).toEqual(['Amount: required']);
  });

  test('a field named like an Object property is an ordinary field', () => {
    const fields = parseFields([{ key: 'constructor', label: 'Builder', type: 'text', required: true }, { key: 'note', label: 'Note', type: 'text' }]);
    expect(problems(() => validateRecordData(fields, { note: 'x' }))).toEqual(['Builder: required']);
    expect(validateRecordData(fields, { constructor: 'ACME' })).toEqual({ constructor: 'ACME' });
  });

  test('a date is stored trimmed', () => {
    expect(validateRecordData(INVOICE, { number: 'R', amount: 1, due: ' 2030-01-02 ' }).due).toBe('2030-01-02');
  });

  test('refuses anything but an object', () => {
    expect(problems(() => validateRecordData(INVOICE, [1, 2]))).toEqual(['Record data must be an object']);
    expect(problems(() => validateRecordData(INVOICE, null))).toEqual(['Record data must be an object']);
  });
});

describe('recordTitle', () => {
  test('the title field, else the first filled text field', () => {
    expect(recordTitle(INVOICE, { number: 'R-1', amount: 1 }, 'number')).toBe('R-1');
    expect(recordTitle(INVOICE, { amount: 1 }, 'number')).toBeNull();
    expect(recordTitle(INVOICE, { number: 'R-2', amount: 1 }, null)).toBe('R-2');
  });
});
