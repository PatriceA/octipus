import { describe, expect, test } from 'vitest';
import { forSpeech, SentenceChunker, stripSpeechSources } from './speech-text';

describe('forSpeech', () => {
  test('markup, code, links, sources and emoji go; the prose stays', () => {
    expect(forSpeech('## Result\n\nIt **works** — see [the docs](https://example.com/a/b) 🎉\n\n```ts\nconst x = 1;\n```\n\n_Sources: recent 10 msgs_'))
      .toBe('Result. It works — see the docs');
    expect(forSpeech('- first\n- second item\n> quoted')).toBe('first, second item, quoted');
    expect(forSpeech('Open https://www.example.com/path?q=1 or `npm test`.')).toBe('Open example.com or npm test.');
    expect(forSpeech('| a | b |\n|---|---|\n| 1 | 2 |')).toBe('a b 1 2');
    expect(forSpeech('Done.\n\n[[octi-ui:11111111-2222-3333-4444-555555555555|Calculator]]')).toBe('Done.');
    expect(forSpeech('An unclosed block:\n```js\nlet a')).toBe('An unclosed block:');
  });

  test('a sources section is dropped in the forms it is written', () => {
    expect(stripSpeechSources('The answer is 4.\n\n**Sources:**\n- a\n- b')).toBe('The answer is 4.');
    expect(stripSpeechSources('Es sind vier. Quellen: Wikipedia')).toBe('Es sind vier.');
    expect(stripSpeechSources('No footer here.')).toBe('No footer here.');
  });
});

describe('SentenceChunker', () => {
  const feed = (chunker: SentenceChunker, parts: string[]) => parts.flatMap((p) => chunker.push(p));

  test('sentences come out as soon as they are complete, while the reply is still streaming', () => {
    const c = new SentenceChunker();
    expect(c.push('Sure. The cap')).toEqual([]); // "Sure." alone is too short to be worth a breath
    expect(c.push('ital of France is Paris. It ha')).toEqual(['Sure. The capital of France is Paris.']);
    expect(c.push('s about two million people')).toEqual([]);
    expect(c.flush()).toEqual(['It has about two million people']);
  });

  test('the first piece goes out early; later short sentences ride with the next', () => {
    const c = new SentenceChunker();
    expect(c.push('Yes, it is. ')).toEqual([]); // the white space may still be followed by nothing
    expect(c.push('N')).toEqual(['Yes, it is.']);
    expect(c.push('o. Maybe. That depends on the weather tomorrow. ')).toEqual([]);
    expect(c.flush()).toEqual(['No. Maybe. That depends on the weather tomorrow.']);
  });

  test('numbers, initials and abbreviations do not end a sentence', () => {
    const c = new SentenceChunker();
    const out = [...feed(c, ['Version 3.5 is out, e.g. for Dr. Smith. ', 'It costs 2.50 euros. ']), ...c.flush()];
    expect(out).toEqual(['Version 3.5 is out, e.g. for Dr. Smith.', 'It costs 2.50 euros.']);
  });

  test('code blocks are skipped whole, even split across deltas; markup is shaped away', () => {
    const c = new SentenceChunker();
    const out = [...feed(c, ['Here is the **fix**:\n\n``', '`ts\nconst a = 1; // not. spoken.\n`', '``\n\nRun it and you are done.\n']), ...c.flush()];
    expect(out).toEqual(['Here is the fix:', 'Run it and you are done.']);
  });

  test('everything after a sources footer is dropped', () => {
    const c = new SentenceChunker();
    const out = [...feed(c, ['It rained on Tuesday in Berlin.\n\n_Sources: weather.com_\nmore text that is not spoken\n']), ...c.flush()];
    expect(out).toEqual(['It rained on Tuesday in Berlin.']);
    expect(c.push('and nothing after that')).toEqual([]);
  });

  test('a long run without a sentence end is cut at a clause', () => {
    const c = new SentenceChunker({ maxChars: 60 });
    const out = c.push('first we take the long road over the hills, then we cross the river by the old bridge and keep walking');
    expect(out[0]).toBe('first we take the long road over the hills');
    expect([...out, ...c.flush()].join(' ')).toBe('first we take the long road over the hills then we cross the river by the old bridge and keep walking');
  });

  test('list items and paragraphs are pieces of their own', () => {
    const c = new SentenceChunker();
    const out = [...feed(c, ['You need three things:\n- a working microphone\n- a quiet room\n- some patience\n']), ...c.flush()];
    expect(out).toEqual(['You need three things:', 'a working microphone, a quiet room', 'some patience']);
  });
});
