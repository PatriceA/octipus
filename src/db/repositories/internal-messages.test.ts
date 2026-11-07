import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterAll, expect, test } from 'vitest';
import { runWithContext } from '@/core/run-context';
import { messageEvents } from './message-events';
import { messageRepository } from './message-repository';
import { sessionRepository } from './session-repository';
import { scopedRepos } from './scoped';
import { resolvedPrincipal } from '@/test-helpers/space-fixtures';
const userId=randomUUID();
process.env.MASTER_KEY ??= randomBytes(32).toString('hex');
process.env.JWT_SECRET ??= randomBytes(32).toString('hex');
process.env.SESSION_SECRET ??= randomBytes(32).toString('hex');
beforeAll(async()=>{
 process.env.STORAGE_MODE='embedded';process.env.DATA_DIR=mkdtempSync(join(tmpdir(),'octipus-internal-chat-'));
 await (await import('@/db/postgres')).initializeDb();await (await import('@/db/migrate')).runMigrations();
 await (await import('@/test-helpers/multiuser-fixtures')).seedUsers([{id:userId,username:'internal-test'}]);
});
afterAll(async()=>{await(await import('@/db/postgres')).closeDb();});

test('internal prompts never displace visible history pages or emit chat messages',async()=>{
 const principal=await resolvedPrincipal(userId,null);
 const session=await sessionRepository.create({userId,workspaceId:principal.workspaceId,channelType:'webchat',channelId:randomUUID()});
 const announced:string[]=[];const onMessage=(row:{content:string})=>{announced.push(row.content);};messageEvents.on('created',onMessage);
 try{
  await messageRepository.create({sessionId:session.id,role:'user',content:'Hello',createdAt:new Date(1000)});
  await runWithContext({runId:'observe',sessionId:session.id,companionObservation:true},async()=>{
   await messageRepository.create({sessionId:session.id,role:'user',content:'Internal wake'});
   await messageRepository.create({sessionId:session.id,role:'assistant',content:'Your project is ready.',createdAt:new Date(2000)});
  });
  await runWithContext({runId:'brief',sessionId:session.id,companionBriefing:true},async()=>{
   await messageRepository.create({sessionId:session.id,role:'user',content:'Internal handoff request'});
   await messageRepository.create({sessionId:session.id,role:'assistant',content:'Full private technical handoff'});
  });
  const visible=['Hello','Your project is ready.'];
  expect(announced).toEqual(visible);
  expect((await messageRepository.findContextMessages(session.id)).map(row=>row.content)).toEqual(visible);
  expect((await messageRepository.findRecentBySession(session.id,2)).map(row=>row.content)).toEqual(visible);
  const scoped=scopedRepos(principal).messages;
  expect((await scoped.findHistoryPage([session.id],2)).map(row=>row.content)).toEqual(visible);
  expect(await scoped.countBySessions([session.id])).toBe(2);
  expect(await messageRepository.countBySessions([session.id])).toBe(2);
 }finally{messageEvents.off('created',onMessage);}
});

test('backfill hides actual internal records while preserving owner quotes and normal updates',async()=>{
 const {queryRaw}=await import('@/db/postgres');
 const session=await sessionRepository.create({userId,channelType:'webchat',channelId:randomUUID(),context:{companionSupervisor:{modelName:'fixture'}}});
 const actor=`brief-${randomUUID()}`;
 await queryRaw(`INSERT INTO agents(id,user_id,session_id,metadata) VALUES($1,$2,$3,'{"companionBriefing":true}')`,[actor,userId,session.id]);
 await messageRepository.create({sessionId:session.id,agentId:actor,role:'assistant',content:'Old internal briefing'});
 await messageRepository.create({sessionId:session.id,role:'user',content:'Companion supervision update. old internal input',metadata:{trigger:'monitor'}});
 await messageRepository.create({sessionId:session.id,role:'user',content:'Companion supervision update. owner quotation',metadata:{trigger:'user'}});
 await messageRepository.create({sessionId:session.id,role:'assistant',content:'A normal owner update'});
 await queryRaw(readFileSync(new URL('../migrations/0169_internal_companion_messages.sql',import.meta.url),'utf8'));
 const principal=await resolvedPrincipal(userId,null);
 const visibleActor=`visible-${randomUUID()}`;
 await queryRaw(`INSERT INTO agents(id,user_id,session_id,metadata) VALUES($1,$2,$3,'{}')`,[visibleActor,userId,session.id]);
 const scopedAgents=scopedRepos(principal).agents;
 expect((await scopedAgents.findBySessions([session.id])).map(row=>row.id)).toEqual([visibleActor]);
 expect(await scopedAgents.countBySessions([session.id])).toBe(1);
 expect((await scopedAgents.findBySession(session.id)).map(row=>row.id)).toEqual([visibleActor]);
 expect((await messageRepository.findBySession(session.id)).map(row=>row.content).sort()).toEqual(['Companion supervision update. owner quotation','A normal owner update'].sort());
});
