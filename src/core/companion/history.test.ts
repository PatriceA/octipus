import {expect,test} from 'vitest';
import type {AgentMessage} from '@/core/types';
import {companionCacheScope,companionHistory} from './history';
const message=(role:AgentMessage['role'],content:string):AgentMessage=>({role,content,timestamp:new Date()});
test('background wakes do not replay a large controller transcript',()=>{
 const history=[message('user','owner request'),message('tool','x'.repeat(250000)),message('assistant','old progress')];
 expect(companionHistory(history,'monitor')).toEqual([]);
 expect(history[1].content.length).toBe(250000);
});
test('interactive context retains checkpoint and recent owner exchanges within a fixed size',()=>{
 const history=[message('user','[Conversation checkpoint]\nDeployment is on tower, through Appwrite.'),
 ...Array.from({length:30},(_,index)=>message(index%2?'assistant':'user',`${index}:`+'x'.repeat(5000))),message('tool','large tool log'),message('user','Companion supervision update. stale observed event')];
 const bounded=companionHistory(history,'user');
 expect(bounded[0].content).toContain('through Appwrite');
 expect(bounded.map(row=>row.content).join('').length).toBeLessThanOrEqual(16000);
 expect(bounded.every(row=>row.role!=='tool'&&!row.content.startsWith('Companion supervision update.'))).toBe(true);
 expect(bounded.at(-1)?.content).toMatch(/^29:/);
 expect(bounded.every(row=>!row.providerRaw&&!row.toolCalls)).toBe(true);
});
test('briefing context is bounded without discarding the saved canonical summary',()=>{
 const result=companionHistory([message('user','[Conversation checkpoint]\nExternal database'),message('assistant','x'.repeat(50000))],'monitor',true);
 expect(result.map(row=>row.content).join('').length).toBeLessThanOrEqual(24000);
 expect(result[0].content).toContain('External database');
});

test('cache affinity stays stable across wakes and separates incompatible prompt/tool shapes',()=>{
 const background={role:'companion',trigger:'monitor' as const,metadata:{}};
 expect(companionCacheScope(background,'generation')).toBe(companionCacheScope({...background,trigger:'schedule'},'generation'));
 expect(companionCacheScope(background,'generation')).not.toBe(companionCacheScope({...background,trigger:'user'},'generation'));
 expect(companionCacheScope(background,'generation')).not.toBe(companionCacheScope(background,'cleared'));
 expect(companionCacheScope({role:'general',trigger:'monitor',metadata:{companionBriefing:true}},'generation')).toBe('briefing:generation');
 expect(companionCacheScope({role:'general',trigger:'user',metadata:{}},'generation')).toBeUndefined();
});
