import { describe, expect, it } from 'vitest';
import { checkValue } from './validate';
import { t } from './t';

describe('t', () => {
  // TypeBox has no formats of its own: before 'uuid' was registered, every
  // route declaring it (email unsnooze/dismiss, note proposals) answered 422.
  it("checks format 'uuid' instead of refusing every value", () => {
    const schema = t.Object({ id: t.String({ format: 'uuid' }) });
    expect(checkValue(schema, { id: '11111111-1111-4111-8111-111111111111' }, 'params')).toEqual({ id: '11111111-1111-4111-8111-111111111111' });
    expect(() => checkValue(schema, { id: 'not-a-uuid' }, 'params')).toThrow(/Invalid params/);
  });
});
