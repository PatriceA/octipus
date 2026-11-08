import { describe, expect, test } from 'vitest';
import type { AgentMessage } from '@/core/types';
import { omitRepeatedContext, REPEATED_CONTEXT_NOTE } from './repeated-context';

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
