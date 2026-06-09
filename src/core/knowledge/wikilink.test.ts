import { describe, expect, test } from 'bun:test';
import { parseLinks, parseTags, parseWikilinks, slugify } from './wikilink';

describe('slugify', () => {
  test('lowercases and dashes whitespace', () => {
    expect(slugify('My Great Note')).toBe('my-great-note');
  });

  test('preserves path separators', () => {
    expect(slugify('daily/2026-06-09')).toBe('daily/2026-06-09');
  });

  test('strips punctuation', () => {
    expect(slugify('Hello, World!')).toBe('hello-world');
  });

  test('collapses repeats and trims edges', () => {
    expect(slugify('  --Foo   Bar-- ')).toBe('foo-bar');
    expect(slugify('a//b')).toBe('a/b');
  });

  test('is idempotent', () => {
    const once = slugify('Some Weird / Title!!');
    expect(slugify(once)).toBe(once);
  });
});

describe('parseWikilinks', () => {
  test('plain link', () => {
    expect(parseWikilinks('see [[Project Plan]] here')).toEqual([
      { target: 'Project Plan', ref: 'project-plan' },
    ]);
  });

  test('alias', () => {
    expect(parseWikilinks('[[Project Plan|the plan]]')).toEqual([
      { target: 'Project Plan', ref: 'project-plan', alias: 'the plan' },
    ]);
  });

  test('heading anchor', () => {
    expect(parseWikilinks('[[Project Plan#Risks]]')).toEqual([
      { target: 'Project Plan', ref: 'project-plan', heading: 'Risks' },
    ]);
  });

  test('heading + alias', () => {
    expect(parseWikilinks('[[Project Plan#Risks|risks]]')).toEqual([
      { target: 'Project Plan', ref: 'project-plan', heading: 'Risks', alias: 'risks' },
    ]);
  });

  test('multiple links, de-duplicated', () => {
    const links = parseWikilinks('[[A]] and [[B]] and [[A]] again');
    expect(links.map((l) => l.ref)).toEqual(['a', 'b']);
  });

  test('ignores links in fenced code', () => {
    const md = 'real [[Yes]]\n```\ncode [[No]]\n```\n';
    expect(parseWikilinks(md).map((l) => l.ref)).toEqual(['yes']);
  });

  test('ignores links in inline code', () => {
    expect(parseWikilinks('use `[[NotALink]]` but [[Real]]').map((l) => l.ref)).toEqual(['real']);
  });

  test('empty target is skipped', () => {
    expect(parseWikilinks('[[ ]] [[#only-heading]]')).toEqual([]);
  });
});

describe('parseTags', () => {
  test('extracts simple tags', () => {
    expect(parseTags('this is #important and #urgent')).toEqual(['important', 'urgent']);
  });

  test('nested tags', () => {
    expect(parseTags('#project/octipus')).toEqual(['project/octipus']);
  });

  test('does not match markdown headings', () => {
    expect(parseTags('# Heading\n## Sub')).toEqual([]);
  });

  test('does not match pure-numeric refs', () => {
    expect(parseTags('fixes #123 but tags #v2release')).toEqual(['v2release']);
  });

  test('lowercases and de-duplicates', () => {
    expect(parseTags('#Foo and #foo')).toEqual(['foo']);
  });

  test('ignores tags in code', () => {
    expect(parseTags('`#nope` and #yes')).toEqual(['yes']);
  });
});

describe('parseLinks', () => {
  test('returns both', () => {
    const r = parseLinks('[[A]] #tag');
    expect(r.wikilinks.map((l) => l.ref)).toEqual(['a']);
    expect(r.tags).toEqual(['tag']);
  });
});
