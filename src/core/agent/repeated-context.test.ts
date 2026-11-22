import { describe, expect, test } from 'vitest';
import type { AgentMessage } from '@/core/types';
import { omitRepeatedContext, REPEATED_CONTEXT_NOTE, restoreOmittedContext, withoutRepeatedContext } from './repeated-context';

const memory = '\n\nKnown about the user (long-term memory):\n- (preference) Prefers TypeScript over JavaScript for new services.\n- (fact) Works on the billing export pipeline.';
const note = '\n\n<context-note title="House style">\nA note the user asked to show you on every turn: their own context and preferences.\nUse British spelling. Keep answers short.\n</context-note>\n';
const date = '\n\nCURRENT DATE & TIME: Sun, 08 Nov 2026 12:00:00 GMT';
const plan = '\n\n---\nPLAN MODE IS ON. You are working out WHAT to do. You are not doing it. Change nothing; a long directive that is repeated every turn on purpose.';

const user = (content: string): AgentMessage => ({ role: 'user', content, timestamp: new Date() });
const turn = (...parts: string[]) => parts.join('').trim();

describe('retrieved blocks already in view are not sent again', () => {
  test('the first turn carries everything', () => {
    const ctx = turn(date, memory, note);
    expect(omitRepeatedContext(ctx, [memory, note], [])).toBe(ctx);
  });

  test('a later turn leaves out what an earlier turn still carries, and says so', () => {
    const history = [user(`${turn(date, memory, note)}\n\nfirst question`), { role: 'assistant', content: 'answer', timestamp: new Date() } as AgentMessage];
    const out = omitRepeatedContext(turn('\n\nCURRENT DATE & TIME: later', memory, note), [memory, note], history);
    expect(out).not.toContain('Prefers TypeScript');
    expect(out).not.toContain('British spelling');
    expect(out).toContain('CURRENT DATE & TIME: later');
    expect(out.endsWith(REPEATED_CONTEXT_NOTE)).toBe(true);
    expect(out).not.toMatch(/\n{3,}/);
  });

  test('a changed block is sent; only the unchanged one is left out', () => {
    const history = [user(turn(date, memory, note))];
    const fresher = `${memory}\n- (fact) Moved the export to a nightly schedule.`;
    const out = omitRepeatedContext(turn(date, fresher, note), [fresher, note], history);
    expect(out).toContain('nightly schedule');
    expect(out).not.toContain('British spelling');
  });

  test('a directive is never left out: only the listed blocks are candidates', () => {
    const history = [user(turn(date, plan, memory))];
    const out = omitRepeatedContext(turn(date, plan, memory), [memory], history);
    expect(out).toContain('PLAN MODE IS ON');
  });

  test('once the earlier copy is out of view (a checkpoint), the block comes back', () => {
    const history = [user('Summary of the conversation so far: the user is working on billing.')];
    const ctx = turn(date, memory, note);
    expect(omitRepeatedContext(ctx, [memory, note], history)).toBe(ctx);
  });

  test('short blocks and non-strings are ignored', () => {
    const history = [user(turn(date, '\n\nshort block'))];
    const ctx = turn(date, '\n\nshort block');
    expect(omitRepeatedContext(ctx, ['\n\nshort block', 42], history)).toBe(ctx);
  });
});

describe('an in-turn compaction that summarizes the earlier copy', () => {
  const earlier = user(`${turn(date, memory, note)}\n\nfirst question`);
  const start = () => {
    const sent = withoutRepeatedContext(turn('\n\nCURRENT DATE & TIME: later', memory, note), [memory, note], [earlier]);
    const message = user(`${sent.text}\n\nsecond question`);
    return { message, state: { content: message.content as string, omitted: sent.omitted, noteAt: sent.noteAt } };
  };

  test('puts the blocks back into this turn\'s message', () => {
    const { message, state } = start();
    const summary: AgentMessage = { role: 'system', content: '[Context Summary] the user asked a first question', timestamp: new Date() };
    // A compaction may copy the message: it is found by content, not identity.
    const history = [summary, { ...message }];
    expect(restoreOmittedContext(history, state)).toBeUndefined();
    expect(history[1].content).toContain('Prefers TypeScript');
    expect(history[1].content).toContain('British spelling');
    expect(history[1].content).not.toContain(REPEATED_CONTEXT_NOTE);
    expect(history[1].content).toContain('second question');
  });

  test('leaves the message alone while the earlier copy is still in view', () => {
    const { message, state } = start();
    const history = [earlier, message];
    expect(restoreOmittedContext(history, state)).toBe(state);
    expect(message.content).toContain(REPEATED_CONTEXT_NOTE);
  });

  test('restores only what went, and keeps the note for what is still above', () => {
    const { message, state } = start();
    const keepsNote = user(`${turn(date, note)}\n\nolder question`);
    const history = [keepsNote, message];
    const next = restoreOmittedContext(history, state);
    expect(message.content).toContain('Prefers TypeScript');
    expect(message.content).not.toContain('British spelling');
    expect(message.content).toContain(REPEATED_CONTEXT_NOTE);
    expect(next?.omitted).toEqual([note.trim()]);
  });

  test('a restored block is put back as written, "$" sequences included', () => {
    const dollars = '\n\n<context-note title="Rates">\nA note the user asked to show you on every turn: their own context and preferences.\nDay rate US$\'900, rush jobs $& weekends $` double.\n</context-note>\n';
    const first = user(`${turn(date, dollars)}\n\nfirst question`);
    const sent = withoutRepeatedContext(turn('\n\nCURRENT DATE & TIME: later', dollars), [dollars], [first]);
    const message = user(`${sent.text}\n\nsecond question`);
    const history = [{ ...message }];
    expect(restoreOmittedContext(history, { content: message.content as string, omitted: sent.omitted, noteAt: sent.noteAt })).toBeUndefined();
    expect(history[0].content).toContain("Day rate US$'900, rush jobs $& weekends $` double.");
  });

  test('a message that was itself compacted away ends the tracking', () => {
    const { state } = start();
    expect(restoreOmittedContext([user('summary only')], state)).toBeUndefined();
  });
});

describe('a group repeated per part (the recall block)', () => {
  const head = '\n\n<recalled-knowledge>\nRetrieved automatically from the user\'s own knowledge base and notes because it matches this message.\n';
  const tail = '</recalled-knowledge>\n';
  const pricing = 'Note "Pricing"\nPricing: a website costs 2400 euro. That covers design, build and one round of changes; hosting is billed apart.\n';
  const hosting = 'Note "Hosting"\nHosting: every website we build runs on our own servers for 15 euro a month, backups and updates included.\n';
  const group = (...parts: string[]) => ({ head, tail, parts });
  const block = (...parts: string[]) => `${head}${parts.join('')}${tail}`;

  test('a passage still in view is left out, a new one is sent inside the fence', () => {
    const history = [user(`${turn(date, block(pricing))}\n\nfirst question`)];
    const sent = withoutRepeatedContext(turn(date, block(pricing, hosting)), [group(pricing, hosting)], history);
    expect(sent.text).not.toContain('2400 euro');
    expect(sent.text).toContain('backups and updates');
    expect(sent.text.match(/<recalled-knowledge>/g)).toHaveLength(1);
    expect(sent.text.indexOf('backups and updates')).toBeLessThan(sent.text.indexOf('</recalled-knowledge>'));
    expect(sent.text.endsWith(REPEATED_CONTEXT_NOTE)).toBe(true);
    expect(sent.omitted).toEqual([pricing.trim()]);
    expect(sent.fences).toEqual([{ head, tail, parts: [pricing.trim()] }]);
    // The hook's block is still partly there: the composition keeps counting it.
    expect(sent.leftOut).toEqual([]);
  });

  test('every passage in view: the fence goes too, no empty shell', () => {
    const history = [user(turn(date, block(pricing))), user(turn(date, block(hosting)))];
    const sent = withoutRepeatedContext(turn('\n\nCURRENT DATE & TIME: later', block(pricing, hosting)), [memory, group(pricing, hosting)], history);
    expect(sent.text).not.toContain('recalled-knowledge');
    expect(sent.text).toBe(`CURRENT DATE & TIME: later\n\n${REPEATED_CONTEXT_NOTE}`);
    expect(sent.leftOut).toEqual([block(pricing, hosting).trim()]);
  });

  test('a short passage is not worth leaving out; a malformed group is ignored', () => {
    const short = 'Note "Hours"\nOpen 9 to 5.\n';
    const history = [user(turn(date, block(short)))];
    const ctx = turn(date, block(short));
    expect(withoutRepeatedContext(ctx, [group(short)], history).text).toBe(ctx);
    expect(withoutRepeatedContext(ctx, [{ head, tail, parts: [1] }, { head }], history).text).toBe(ctx);
  });

  test('a restore puts a passage back inside the fence still in the message', () => {
    const earlier = user(`${turn(date, block(pricing))}\n\nfirst question`);
    const sent = withoutRepeatedContext(turn(date, block(pricing, hosting)), [group(pricing, hosting)], [earlier]);
    const message = user(`${sent.text}\n\nsecond question`);
    const history: AgentMessage[] = [{ role: 'system', content: '[Context Summary] pricing came up', timestamp: new Date() }, message];
    expect(restoreOmittedContext(history, { content: message.content as string, omitted: sent.omitted, fences: sent.fences, noteAt: sent.noteAt })).toBeUndefined();
    const content = message.content as string;
    expect(content.match(/<recalled-knowledge>/g)).toHaveLength(1);
    const close = content.indexOf('</recalled-knowledge>');
    expect(content.indexOf('2400 euro')).toBeGreaterThan(content.indexOf('<recalled-knowledge>'));
    expect(content.indexOf('2400 euro')).toBeLessThan(close);
    expect(content).not.toContain(REPEATED_CONTEXT_NOTE);
    expect(content.endsWith('second question')).toBe(true);
  });

  test('a restore of a fully omitted group brings the fence back, and keeps tracking what is still above', () => {
    const history0 = [user(turn(date, block(pricing))), user(turn(date, memory, block(hosting)))];
    const sent = withoutRepeatedContext(turn(date, memory, block(pricing, hosting)), [memory, group(pricing, hosting)], history0);
    expect(sent.text).not.toContain('recalled-knowledge');
    const message = user(`${sent.text}\n\nthird question`);
    // The compaction dropped the turn with the pricing passage; the one with memory and hosting stays.
    const history = [history0[1], message];
    const next = restoreOmittedContext(history, { content: message.content as string, omitted: sent.omitted, fences: sent.fences, noteAt: sent.noteAt });
    const content = message.content as string;
    expect(content).toContain(`<recalled-knowledge>`);
    expect(content).toContain('2400 euro');
    expect(content).not.toContain('backups and updates');
    expect(content).toContain(REPEATED_CONTEXT_NOTE);
    expect(next?.omitted.sort()).toEqual([memory.trim(), hosting.trim()].sort());
    expect(next?.fences).toEqual([{ head, tail, parts: [hosting.trim()] }]);
  });
});

describe('in view means the same block, not a longer one that starts the same way', () => {
  const head = '\n\n<recalled-knowledge>\nRetrieved automatically from the user\'s own knowledge base and notes because it matches this message.\n';
  const tail = '</recalled-knowledge>\n';
  const block = (...parts: string[]) => `${head}${parts.join('')}${tail}`;

  test('a passage edited to drop its last sentence is sent, not taken for its earlier copy', () => {
    const before = 'Note "Pricing"\nPricing: a website costs 2400 euro. That covers design, build, testing, launch support and one round of changes. Hosting is billed apart at 15 euro.\n';
    const after = 'Note "Pricing"\nPricing: a website costs 2400 euro. That covers design, build, testing, launch support and one round of changes.\n';
    expect(after.trim().length).toBeGreaterThan(120);
    const history = [user(`${turn(date, block(before))}\n\nfirst question`)];
    const sent = withoutRepeatedContext(turn(date, block(after)), [{ head, tail, parts: [after] }], history);
    expect(sent.omitted).toEqual([]);
    expect(sent.text).toContain('one round of changes.\n');
    expect(sent.text).not.toContain(REPEATED_CONTEXT_NOTE);
  });

  test('a plain block shortened by its last line is sent', () => {
    const longer = `${memory}\n- (fact) Moved the export to a nightly schedule.`;
    expect(memory.trim().length).toBeGreaterThan(120);
    const history = [user(`${turn(date, longer, note)}\n\nfirst question`)];
    const out = omitRepeatedContext(turn(date, memory, note), [memory, note], history);
    expect(out).toContain('billing export pipeline');
    expect(out).not.toContain('British spelling');
  });

  test('a restore does not count a longer copy as the block still in view', () => {
    const before = 'Note "Pricing"\nPricing: a website costs 2400 euro. That covers design, build, testing, launch support and one round of changes. Hosting is billed apart at 15 euro.\n';
    const after = 'Note "Pricing"\nPricing: a website costs 2400 euro. That covers design, build, testing, launch support and one round of changes.\n';
    expect(after.trim().length).toBeGreaterThan(120);
    const earlier = user(`${turn(date, block(after))}\n\nfirst question`);
    const sent = withoutRepeatedContext(turn(date, block(after)), [{ head, tail, parts: [after] }], [earlier]);
    expect(sent.omitted).toEqual([after.trim()]);
    const message = user(`${sent.text}\n\nsecond question`);
    // The compaction kept only a longer copy of the passage (an older turn).
    const history = [user(`${turn(date, block(before))}\n\nolder`), message];
    expect(restoreOmittedContext(history, { content: message.content as string, omitted: sent.omitted, fences: sent.fences, noteAt: sent.noteAt })).toBeUndefined();
    expect(message.content).toContain('one round of changes.\n');
  });
});

describe('the restore anchors on the note it put there', () => {
  test('a block that quotes the note does not receive the restored blocks', () => {
    const quoting = `\n\n<context-note title="About Octipus">\nA note the user asked to show you on every turn.\nThe agent sometimes says: ${REPEATED_CONTEXT_NOTE}\n</context-note>\n`;
    const earlier = user(`${turn(date, memory)}\n\nfirst question`);
    const sent = withoutRepeatedContext(turn(date, memory, quoting), [memory, quoting], [earlier]);
    expect(sent.omitted).toEqual([memory.trim()]);
    // The quoting block is sent and comes first; the note the omission added is the last occurrence.
    expect(sent.text.indexOf(REPEATED_CONTEXT_NOTE)).toBeLessThan(sent.noteAt);
    const message = user(`${sent.text}\n\nwhat about ${REPEATED_CONTEXT_NOTE}`);
    const history = [{ role: 'system', content: '[Context Summary] earlier turns', timestamp: new Date() } as AgentMessage, message];
    expect(restoreOmittedContext(history, { content: message.content as string, omitted: sent.omitted, noteAt: sent.noteAt })).toBeUndefined();
    const content = message.content as string;
    // Restored after the quoting block, where the note was; the quote and the user's text are untouched.
    expect(content.indexOf('Prefers TypeScript')).toBeGreaterThan(content.indexOf('</context-note>'));
    expect(content).toContain(`The agent sometimes says: ${REPEATED_CONTEXT_NOTE}\n</context-note>`);
    expect(content.endsWith(`what about ${REPEATED_CONTEXT_NOTE}`)).toBe(true);
    expect(content.split(REPEATED_CONTEXT_NOTE)).toHaveLength(3);
  });

  test('the state kept for a later restore points at the note in the rewritten message', () => {
    const earlier = user(`${turn(date, memory)}\n\nfirst`);
    const keepsNote = user(`${turn(date, note)}\n\nolder`);
    const sent = withoutRepeatedContext(turn(date, memory, note), [memory, note], [earlier, keepsNote]);
    const message = user(`${sent.text}\n\nsecond`);
    const next = restoreOmittedContext([keepsNote, message], { content: message.content as string, omitted: sent.omitted, noteAt: sent.noteAt });
    expect(next?.omitted).toEqual([note.trim()]);
    expect((message.content as string).slice(next?.noteAt ?? -1).startsWith(REPEATED_CONTEXT_NOTE)).toBe(true);
    expect(restoreOmittedContext([message], next as NonNullable<typeof next>)).toBeUndefined();
    expect(message.content).toContain('British spelling');
    expect(message.content).not.toContain(REPEATED_CONTEXT_NOTE);
  });
});
