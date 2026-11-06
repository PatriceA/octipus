import type { AgentContext, AgentMessage } from '@/core/types';

/** Journals hold project state. A wake must not replay the controller's tool log. */
export function companionHistory(messages: AgentMessage[], trigger: AgentContext['trigger'], briefing=false): AgentMessage[] {
  if(trigger!=='user'&&!briefing)return [];
  const budget=briefing?24000:16000;
  const checkpoint=messages.find(message=>message.content.startsWith('[Conversation checkpoint]'));
  const checkpointText=checkpoint?.content.slice(0,6000);
  const selected=messages.filter(message=>(message.role==='user'||message.role==='assistant')
    && message!==checkpoint && !message.content.startsWith('Companion supervision update.') && !message.toolCalls?.length).slice(-10);
  let remaining=budget-(checkpointText?.length??0);
  const recent=selected.reverse().flatMap(message=>{
    if(remaining<=0)return [];
    const content=message.content.slice(0,Math.min(remaining,briefing?6000:2400));remaining-=content.length;
    return [{role:message.role,content,timestamp:message.timestamp}];
  }).reverse();
  return checkpoint&&checkpointText?[{role:'user',content:checkpointText,timestamp:checkpoint.timestamp},...recent]:recent;
}

/** Stable affinity per prompt/tool shape, never per wake or agent ID. */
export function companionCacheScope(context:Pick<AgentContext,'role'|'trigger'|'metadata'>,generation:string):string|undefined{
 if(context.metadata.companionBriefing===true)return `briefing:${generation}`;
 if(context.role==='companion')return `companion:${context.trigger==='user'?'owner':'background'}:${generation}`;
 return undefined;
}
