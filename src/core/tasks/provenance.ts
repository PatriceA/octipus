import {canActInSession} from '@/core/rooms/access';
import {and,eq,inArray,sql} from 'drizzle-orm';
import {getDb} from '@/db/postgres';
import {sessions} from '@/db/schema/sessions';
import type {AgentContext} from '@/core/types';
import {raiseSessionLevel,sessionProtectionLevel} from '@/core/protection/session-level';
import {getFlowLabel,observeFlow} from '@/security/flow-guard';
import {isUuid} from '@/db/repositories/scoped';

export interface TaskProvenance {protectionLevel:number;flowLabel:Partial<Record<'private'|'secret'|'suspicious',string>>}
const empty=():TaskProvenance=>({protectionLevel:1,flowLabel:{}});
const flags=['private','secret','suspicious'] as const;
export async function taskSourceRef(context:AgentContext){
 const ref:{sessionId:string;protectionLevel?:number;flowLabel?:TaskProvenance['flowLabel']}={sessionId:context.sessionId};
 if(context.space)return ref;
 const label=getFlowLabel(context.sessionId);const flowLabel:TaskProvenance['flowLabel']={};
 for(const flag of flags)if(label[flag])flowLabel[flag]=label.sources[flag]??'Todo source';
 let protectionLevel=sessionProtectionLevel(context.sessionId);
 if(isUuid(context.sessionId)){
  const [source]=await getDb().select({level:sessions.protectionLevel,flow:sessions.flowLabel}).from(sessions).where(and(eq(sessions.id,context.sessionId),eq(sessions.userId,context.userId)));
  protectionLevel=Math.max(protectionLevel,source?.level??1) as typeof protectionLevel;Object.assign(flowLabel,source?.flow??{});
 }
 return {...ref,protectionLevel,flowLabel};
}
export async function taskProvenance(userId:string,items:ReadonlyArray<{sourceRef?:unknown}>):Promise<TaskProvenance>{
 const result=empty();const ids:string[]=[];
 for(const item of items){
  const ref=item.sourceRef as {sessionId?:unknown;protectionLevel?:unknown;flowLabel?:TaskProvenance['flowLabel']}|null;
  if(!ref)continue;
  if(typeof ref.protectionLevel==='number'&&Number.isInteger(ref.protectionLevel)&&ref.protectionLevel>=1&&ref.protectionLevel<=4)result.protectionLevel=Math.max(result.protectionLevel,ref.protectionLevel);
  for(const flag of flags)if(ref.flowLabel?.[flag])result.flowLabel[flag]=String(ref.flowLabel[flag]);
  if(typeof ref.sessionId==='string'&&isUuid(ref.sessionId))ids.push(ref.sessionId);
 }
 if(ids.length){
  const rows=await getDb().select({level:sessions.protectionLevel,flow:sessions.flowLabel}).from(sessions).where(and(eq(sessions.userId,userId),inArray(sessions.id,[...new Set(ids)])));
  for(const row of rows){result.protectionLevel=Math.max(result.protectionLevel,row.level??1);Object.assign(result.flowLabel,row.flow??{});}
 }
 return result;
}
export function observeTaskProvenance(sessionId:string,source:TaskProvenance){
 raiseSessionLevel(sessionId,source.protectionLevel);observeFlow(sessionId,{toolId:'tasks',action:'read'},{taints:flags.filter(flag=>!!source.flowLabel[flag])});
}
export async function persistHeartbeatTaskProvenance(userId:string,sessionId:string,source:TaskProvenance){
 if(source.protectionLevel===1&&!Object.keys(source.flowLabel).length)return;
 const {sessionRepository}=await import('@/db/repositories/session-repository');let session=await sessionRepository.findById(sessionId);
 if(!session)session=await sessionRepository.createAutomation({id:sessionId,userId,channelType:'heartbeat',channelId:userId});
 if(!await canActInSession(session,userId,'personal_tool'))throw new Error('Heartbeat source session owner mismatch');
 const [stored]=await getDb().update(sessions).set({protectionLevel:sql`greatest(coalesce(${sessions.protectionLevel},1),${source.protectionLevel})`,flowLabel:sql`coalesce(${sessions.flowLabel},'{}'::jsonb)||${JSON.stringify(source.flowLabel)}::jsonb`}).where(and(eq(sessions.id,sessionId),eq(sessions.userId,userId))).returning({id:sessions.id});
 if(!stored)throw new Error('Heartbeat source protection could not be persisted');observeTaskProvenance(sessionId,source);
}
