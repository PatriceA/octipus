import { runWithContext } from '@/core/run-context';
import { afterEach, describe, expect, test } from 'vitest';
import {
  beginReadOnlyTurn, endReadOnlyTurn, isReadOnlyTurn, readOnlyNotifyAllowed, readOnlyRefusal, resetReadOnlyTurns,
} from './read-only-turn';

const S = 'sess-1';
const U = 'user-1';

afterEach(() => resetReadOnlyTurns());

describe('read-only turn marks', () => {
  test('nest per session and clear when the last turn ends', () => {
    beginReadOnlyTurn(S);
    beginReadOnlyTurn(S);
    endReadOnlyTurn(S);
    expect(isReadOnlyTurn(S)).toBe(true);
    endReadOnlyTurn(S);
    expect(isReadOnlyTurn(S)).toBe(false);
    expect(isReadOnlyTurn('other')).toBe(false);
    expect(isReadOnlyTurn(undefined)).toBe(false);
  });
});

describe('readOnlyRefusal', () => {
  test('outside a read-only turn nothing is refused', () => {
    expect(readOnlyRefusal(S, U, { toolId: 'shell', action: 'execute' })).toBeUndefined();
  });

  test('reads, read-only handlers and CLI readers run', () => {
    beginReadOnlyTurn(S);
    for (const call of [
      { toolId: 'filesystem', action: 'read' }, { toolId: 'filesystem', action: 'list' },
      { toolId: 'git', action: 'read' }, { toolId: 'github', action: 'read' },
      { toolId: 'knowledge', action: 'search' }, { toolId: 'agent', action: 'list_skills', readOnlyHandler: true },
      { toolId: 'cli-native:Grep', action: 'Grep' },
    ]) expect(readOnlyRefusal(S, U, call), JSON.stringify(call)).toBeUndefined();
  });

  test('writes, commands, web, MCP, delegation and posting are refused', () => {
    beginReadOnlyTurn(S);
    for (const call of [
      { toolId: 'filesystem', action: 'write' }, { toolId: 'filesystem', action: 'delete' },
      { toolId: 'shell', action: 'execute' }, { toolId: 'git', action: 'push' }, { toolId: 'git', action: 'write' },
      { toolId: 'github', action: 'write' }, { toolId: 'github', action: 'manage' },
      { toolId: 'websearch', action: 'search' }, { toolId: 'reader', action: 'read' },
      { toolId: 'mcp', action: 'mcp_call_tool' }, { toolId: 'agent', action: 'spawn_child' },
      { toolId: 'knowledge', action: 'index' }, { toolId: 'cli-native:Bash', action: 'Bash' },
      { toolId: 'cli-native:WebFetch', action: 'WebFetch' },
    ]) expect(readOnlyRefusal(S, U, call), JSON.stringify(call)).toMatch(/read-only turn/);
  });

  test('send_to_user to the turn\'s own user is the notify step; anyone else is refused', () => {
    beginReadOnlyTurn(S);
    // `send_to_user` is the action the real handler reports; `send` the manifest action.
    expect(readOnlyRefusal(S, U, { toolId: 'messaging', action: 'send_to_user', args: { user_id: U, message: 'x' } })).toBeUndefined();
    // One of the owner's channels is still only the owner.
    expect(readOnlyRefusal(S, U, { toolId: 'messaging', action: 'send_to_user', args: { user_id: U, channel: 'telegram', message: 'x' } })).toBeUndefined();
    const notify = { toolId: 'messaging', action: 'send', args: { user_id: U, message: 'CI is red' } };
    expect(readOnlyRefusal(S, U, notify)).toBeUndefined();
    expect(readOnlyNotifyAllowed(S, U, notify)).toBe(true);
    for (const args of [{ user_id: 'someone-else', message: 'x' }, { user_id: U, target: '123', message: 'x' }, { channel: 'slack', target: 'C1', message: 'x' }]) {
      const call = { toolId: 'messaging', action: 'send', args };
      expect(readOnlyRefusal(S, U, call)).toMatch(/read-only turn/);
      expect(readOnlyNotifyAllowed(S, U, call)).toBe(false);
    }
    endReadOnlyTurn(S);
    expect(readOnlyNotifyAllowed(S, U, notify)).toBe(false);
  });
});

test('a session briefing is isolated to its asynchronous run, including with a missing model binding',async()=>{
 const {runWithContext}=await import('@/core/run-context');
 await runWithContext({runId:'brief',sessionId:S,companionBriefing:true},async()=>{
   await Promise.resolve();
   expect(readOnlyRefusal(S,U,{toolId:'shell',action:'execute'})).toMatch(/read-only/);
   expect(readOnlyRefusal(S,U,{toolId:'filesystem',action:'read'})).toBeUndefined();
   expect(readOnlyRefusal('parallel-session',U,{toolId:'shell',action:'execute'})).toBeUndefined();
 });
 expect(readOnlyRefusal(S,U,{toolId:'shell',action:'execute'})).toBeUndefined();
});

test('an explicit briefing context remains read-only outside ambient async storage',()=>{
 expect(readOnlyRefusal(S,U,{toolId:'shell',action:'execute'},true)).toMatch(/read-only/);
 expect(readOnlyRefusal(S,U,{toolId:'filesystem',action:'read'},true)).toBeUndefined();
 expect(readOnlyRefusal(S,U,{toolId:'shell',action:'execute'})).toBeUndefined();
});


test('internal briefings cannot send their handoff to owner channels',()=>{
 const call={toolId:'messaging',action:'send_to_user',args:{user_id:U,message:'Internal handoff'}};
 runWithContext({runId:'brief',sessionId:S,companionBriefing:true},()=>{
  expect(readOnlyRefusal(S,U,call)).toContain('internally');expect(readOnlyNotifyAllowed(S,U,call)).toBe(false);
 });
 expect(readOnlyRefusal(S,U,call,true)).toContain('internally');
});
