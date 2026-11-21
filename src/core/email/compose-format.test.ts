import { describe, expect, test } from 'vitest';
import { composeParts } from './compose-format';

describe('a reply or forward formats what the writer typed, never the original below it', () => {
  const original = 'On Mon, Boss wrote:\n> *important* - see list\n> 1. do X\n> > older quote\n> _not italic_ <b>no tag</b>';
  const typed = 'Thanks, **done**.\n\n';

  test('the original goes as text: no emphasis, list or nested quote made of its signs', () => {
    const { text, html } = composeParts(typed + original, 'rich', typed.length);
    expect(text).toBe('Thanks, done.\n\n' + original);
    expect(html).toContain('<strong>done</strong>');
    const quoted = html!.slice(html!.indexOf('<blockquote>'));
    expect(quoted).toContain('*important* - see list');
    expect(quoted).toContain('1. do X');
    expect(quoted).toContain('&gt; older quote');
    expect(quoted).toContain('_not italic_ &lt;b&gt;no tag&lt;/b&gt;');
    expect(quoted).not.toMatch(/<em>|<ol>|<ul>|<li>|<b>/);
  });

  test('a forward header and body are text too', () => {
    const fwd = '---------- Forwarded message ----------\nFrom: a@x\n\n- item\n**loud**';
    const { text, html } = composeParts('See below\n\n' + fwd, 'rich', 'See below\n\n'.length);
    expect(text.endsWith(fwd)).toBe(true);
    expect(html).not.toMatch(/<ul>|<strong>/);
    expect(html).toContain('- item<br>**loud**');
  });

  test('without a known original everything is formatted, as for a new mail; plain stays plain', () => {
    expect(composeParts('- a\n- b', 'rich').html).toContain('<ul>');
    expect(composeParts('- a', 'plain')).toEqual({ text: '- a' });
    // An offset outside the body is ignored.
    expect(composeParts('**x**', 'rich', 999).html).toContain('<strong>x</strong>');
  });
});
