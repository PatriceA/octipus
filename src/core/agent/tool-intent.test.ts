import { describe, expect, it, test } from 'vitest';
import { CORE_TOOL_FLOOR, selectCoreToolIds, stickyCoreToolIds } from './tool-intent';

// The `general` role's core list, which is what this actually runs against.
const GENERAL = ['filesystem', 'shell', 'repo_registry', 'websearch', 'knowledge', 'messaging', 'notes', 'tasks', 'skill-distill'];

const FIX_TASK = 'The unit tests in this directory fail. Read README.md for the contract they encode, then fix ledger.py until `python3 -m unittest discover` passes with every test green.';

describe('selectCoreToolIds', () => {
  it('keeps only the floor for a coding message that names nothing else', () => {
    expect(selectCoreToolIds(FIX_TASK, GENERAL)).toEqual(['filesystem', 'shell', 'skill-distill']);
  });

  it('never grants a group the role does not already hold', () => {
    const narrow = ['filesystem', 'shell'];
    expect(selectCoreToolIds('search the web and check my notes and tasks', narrow)).toEqual(narrow);
  });

  it('keeps the floor even when the message is empty', () => {
    expect(selectCoreToolIds('', GENERAL)).toEqual(CORE_TOOL_FLOOR);
  });

  it.each([
    ['search the web for the latest release', 'websearch'],
    ['what do we know about the pricing model?', 'knowledge'],
    ['add a note about the migration', 'notes'],
    ['write down that the deploy is on Friday', 'notes'],
    ['add this to my to-do list', 'tasks'],
    ['remind me to renew the domain', 'tasks'],
    ['send them a slack message', 'messaging'],
    ['clone the repository first', 'repo_registry'],
  ])('keeps %s -> %s', (message, group) => {
    expect(selectCoreToolIds(message, GENERAL)).toContain(group);
  });

  // The words that are ordinary English before they are a toolbox. The worker
  // path runs this against a child's task BRIEF, which says "task" nearly every
  // time, so a bare-noun pattern would pin these groups to every spawn.
  it.each([
    ['Your task is to fix the failing assertion in ledger.py', 'tasks'],
    ['Note that the index is off by one in the current implementation', 'notes'],
    ['Note that the index is off by one in the current implementation', 'knowledge'],
    ['Check the current branch before you rebase', 'websearch'],
  ])('does not keep %s -> %s', (message, group) => {
    expect(selectCoreToolIds(message, GENERAL)).not.toContain(group);
  });

  it('fails open for a group with no trigger of its own', () => {
    // A group added to a role's core list but not to the intent table must
    // survive, or shipping a new tool silently loses it.
    expect(selectCoreToolIds(FIX_TASK, [...GENERAL, 'brand-new-tool'])).toContain('brand-new-tool');
  });

  it('is a subset of the role list, in the role list order', () => {
    const picked = selectCoreToolIds('search my notes and my tasks', GENERAL);
    expect(picked).toEqual(GENERAL.filter((id) => picked.includes(id)));
  });
});

describe('stickyCoreToolIds', () => {
  const role = ['filesystem', 'shell', 'websearch', 'notes', 'messaging'];
  const scope = { generation: 'g1', checkpointId: 'c1' };

  test('a group stays once the conversation advertised it, in the role order', () => {
    const first = stickyCoreToolIds(['filesystem', 'shell', 'websearch'], role, undefined, scope);
    expect(first).toEqual({ ids: ['filesystem', 'shell', 'websearch'], changed: true });
    // "thanks, summarize" names no web search: it stays advertised.
    const second = stickyCoreToolIds(['filesystem', 'shell'], role, { ...scope, ids: first.ids }, scope);
    expect(second).toEqual({ ids: ['filesystem', 'shell', 'websearch'], changed: false });
    const third = stickyCoreToolIds(['filesystem', 'shell', 'notes'], role, { ...scope, ids: second.ids }, scope);
    expect(third).toEqual({ ids: ['filesystem', 'shell', 'websearch', 'notes'], changed: true });
  });

  test('a clear or a checkpoint lets the list shrink again (the cache resets there anyway)', () => {
    const stored = { ...scope, ids: ['filesystem', 'shell', 'websearch'] };
    expect(stickyCoreToolIds(['filesystem', 'shell'], role, stored, { generation: 'g2', checkpointId: undefined }).ids).toEqual(['filesystem', 'shell']);
    expect(stickyCoreToolIds(['filesystem', 'shell'], role, stored, { generation: 'g1', checkpointId: 'c2' }).ids).toEqual(['filesystem', 'shell']);
  });

  test('never reaches past the role list', () => {
    const stored = { ...scope, ids: ['filesystem', 'repo_registry'] };
    expect(stickyCoreToolIds(['shell'], role, stored, scope).ids).toEqual(['filesystem', 'shell']);
  });
});
