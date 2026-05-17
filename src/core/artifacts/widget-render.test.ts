import { describe, expect, test } from 'bun:test';
import { resolveWidgetTags } from './widget-render';

describe('resolveWidgetTags', () => {
  test('replaces self-closing tags', () => {
    const out = resolveWidgetTags(
      '<p>before</p><x-widget id="kpi"/><p>after</p>',
      { kpi: '<div>K</div>' },
    );
    expect(out).toBe('<p>before</p><div>K</div><p>after</p>');
  });

  test('replaces paired tags', () => {
    const out = resolveWidgetTags(
      '<x-widget id="t"></x-widget>',
      { t: '<table/>' },
    );
    expect(out).toBe('<table/>');
  });

  test('leaves unknown slots untouched', () => {
    const html = '<x-widget id="unknown"/>';
    expect(resolveWidgetTags(html, {})).toBe(html);
  });

  test('handles multiple distinct slots', () => {
    const out = resolveWidgetTags(
      '<x-widget id="a"/><x-widget id="b"/>',
      { a: '[A]', b: '[B]' },
    );
    expect(out).toBe('[A][B]');
  });

  test('ignores tags with quotes/spaces it cannot parse', () => {
    const html = '<x-widget>plain</x-widget>';
    expect(resolveWidgetTags(html, {})).toBe(html);
  });
});
