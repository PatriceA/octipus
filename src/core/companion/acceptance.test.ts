import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { detectRunner } from '@/security/shell-sandbox';
import type { AgentContext } from '@/core/types';

const agentBoundary=vi.hoisted(()=>({handle:vi.fn(),publish:vi.fn()}));
vi.mock('@/core/agent/service',()=>({getAgentService:()=>({handleMessage:agentBoundary.handle,publishResponse:agentBoundary.publish,canSteer:()=>false,steer:()=>false})}));
const dir=mkdtempSync(join(tmpdir(),'octipus-companion-acceptance-'));
const root=join(dir,'installation'), outside=join(dir,'host-cache');mkdirSync(root);mkdirSync(outside);
const userId=randomUUID(),workspaceId=randomUUID();let sessionId='',goalId='';let context:AgentContext;
const random=()=>randomBytes(24).toString('hex');
process.env.MASTER_KEY=`test-master-${random()}`;process.env.JWT_SECRET=`test-jwt-${random()}`;process.env.SESSION_SECRET=`test-session-${random()}`;
const sandboxAvailable=detectRunner()!==null;
process.env.OCTIPUS_STATE_DIR=join(dir,'state');
process.env.STORAGE_MODE='embedded';process.env.DATA_DIR=join(dir,'db');process.env.LOG_LEVEL='error';

beforeAll(async()=>{
 const {initializeDb,getDb}=await import('@/db/postgres');await initializeDb();
 const {runMigrations}=await import('@/db/migrate');await runMigrations();
 const {seedUsers}=await import('@/test-helpers/multiuser-fixtures');await seedUsers([{id:userId,username:'companion-acceptance'}]);
 const {workspaces}=await import('@/db/schema/organizations');await getDb().insert(workspaces).values({id:workspaceId,userId,slug:'companion-test',name:'Companion test',filesDir:'companion-test'});
 const {getConfig,refreshConfigKey}=await import('@/config');getConfig();
 refreshConfigKey('workspace.rootPath',join(dir,'workspace'));refreshConfigKey('workspace.documentsPath',join(dir,'documents'));
 (await import('@/security/workspace-fs')).noteWorkspaceRows([{id:workspaceId,userId,filesDir:'companion-test'}]);
 refreshConfigKey('security.shellSandbox','required');
 refreshConfigKey('security.companionMaintenance',{enabled:true,userId,roots:[dir],hostServices:false,sshAgent:false,allowActivation:false,interruptionPolicy:'wait'});
 const {CompanionSupervisionRepository}=await import('@/db/repositories/companion-supervision-repository');const repo=new CompanionSupervisionRepository({userId,workspaceId});
 await repo.saveSettings({enabled:true,modelName:'fixture-local',autonomy:'repair'},0);
 const goal=await repo.create({requestKey:randomUUID(),title:'Repair a runtime',request:'Repair and verify the configured runtime',outcome:'The affected runtime works',acceptanceCriteria:['Fresh gate passes']});goalId=goal.id;
 const {maintenanceRuntime}=await import('./maintenance');
 const action=await repo.startSession(goal.id,{requestKey:randomUUID(),expectedRevision:0,modelName:'fixture-local'},true,maintenanceRuntime({userId,workspaceId}).binding);sessionId=action.sessionId;
 context={id:'maintenance-fixture',sessionId,userId,workspaceId,root:true,role:'general',topic:'general',model:'fixture-local',space:null,trigger:'monitor',funding:'own',status:'running',createdAt:new Date(),updatedAt:new Date(),metadata:{}};
 const {agents}=await import('@/db/schema/agents');await getDb().insert(agents).values({id:context.id,sessionId,userId,workspaceId,role:'general',status:'running'});
 execFileSync('git',['init','-q',root]);writeFileSync(join(root,'source.txt'),'source-v1');
},120000);
afterAll(async()=>{await(await import('@/db/postgres')).closeDb();rmSync(dir,{recursive:true,force:true});});

test.skipIf(!sandboxAvailable)('operator maintenance directories outside project workspace work through actual approval route and sandbox',async()=>{
 const {routeApprovalFor}=await import('@/security/approval-route');
 const call={toolId:'companion',action:'execute',toolName:'maintenance_run',args:{command:'pwd',cwd:outside}};
 expect(await routeApprovalFor(context,call,{level:'ASK'})).toMatchObject({route:'execute',source:'companion-goal'});
 const {askStillAuthorized}=await import('@/security/approved-calls');expect(await askStillAuthorized('companion-goal',context,call)).toBe(true);
 const {runMaintenance}=await import('./maintenance');
 const result=await runMaintenance(context,{command:'touch cache-repaired',cwd:outside});
 expect(result.exitCode).toBe(0);expect(readFileSync(join(outside,'cache-repaired'),'utf8')).toBe('');
 expect(await routeApprovalFor(context,{...call,args:{command:'pwd',cwd:'/unapproved-maintenance-root'}},{level:'DENY'})).toMatchObject({route:'deny'});
});

test.skipIf(!sandboxAvailable)('managed activation needs current source tests/build and independent review, and stale proof expires',async()=>{
 const {recordMaintenanceCheck,recordMaintenanceReview,assertMaintenanceAcceptance}=await import('./maintenance-evidence');
 const {maintenanceRuntime}=await import('./maintenance');const binding=maintenanceRuntime({userId,workspaceId}).binding;
 expect(await recordMaintenanceCheck(context,{root,kind:'tests',command:'test -f source.txt'})).toMatchObject({passed:true});
 expect(await recordMaintenanceCheck(context,{root,kind:'build',command:'test -s source.txt'})).toMatchObject({passed:true});
 await expect(recordMaintenanceReview(context,{root,passed:true,summary:'Self review'})).rejects.toThrow('independent');
 const {agents}=await import('@/db/schema/agents');const {getDb}=await import('@/db/postgres');
 await getDb().insert(agents).values({id:'independent-reviewer',parentAgentId:context.id,sessionId,userId,workspaceId,role:'review',status:'running'});
 await recordMaintenanceReview({...context,id:'independent-reviewer',root:false,role:'review'},{root,passed:true,summary:'Reviewed current source and validation'});
 expect(await assertMaintenanceAcceptance(sessionId,root,binding)).toMatch(/^[0-9a-f]{64}$/);
 writeFileSync(join(root,'source.txt'),'source-v2');await expect(assertMaintenanceAcceptance(sessionId,root,binding)).rejects.toThrow('current source');
});

test.skipIf(!sandboxAvailable)('a runtime blocker survives restart, is repaired, verified in its affected sandbox and continues the original session',async()=>{
 const {getDb,closeDb,initializeDb}=await import('@/db/postgres');
 const {CompanionSupervisionRepository}=await import('@/db/repositories/companion-supervision-repository');
 let repo=new CompanionSupervisionRepository({userId,workspaceId});
 const detail=await repo.read(goalId);
 const project=await repo.startSession(goalId,{expectedRevision:detail.goal.revision,requestKey:randomUUID(),modelName:'fixture-local',projectPath:root});
 await repo.authorizeGoal(goalId,{executionScope:'run',repoPath:root,overnight:true},(await repo.read(goalId)).goal.revision);
 const {agents}=await import('@/db/schema/agents');
 await getDb().insert(agents).values({id:'failed-sdk-gate',sessionId:project.sessionId,userId,workspaceId,role:'qa',status:'failed',error:'SDK location not found: required runtime-sdk is missing'});
 const incident=(await repo.detectIncident(goalId,project.sessionId))!;expect(incident.category).toBe('environment');
 await repo.advanceIncident(goalId,incident.id,{expectedRevision:0,strategy:'Restore the approved SDK prerequisite, then execute a fresh affected-runtime check'});
 await closeDb();await initializeDb();repo=new CompanionSupervisionRepository({userId,workspaceId});
 expect((await repo.incidents(goalId))[0]).toMatchObject({id:incident.id,state:'repairing'});
 const {runMaintenance}=await import('./maintenance');
 expect((await runMaintenance(context,{command:'touch runtime-sdk',cwd:root})).exitCode).toBe(0);
 const {getToolRegistry}=await import('@/tools/registry');const {ShellTool}=await import('@/tools/shell');const {CompanionTool}=await import('@/tools/companion');
 const registry=getToolRegistry();await registry.register(new ShellTool());const tools=new CompanionTool();await tools.initialize();
 const actor={...context,id:'affected-runtime-verifier',sessionId:project.sessionId,metadata:{projectPath:root}};
 await getDb().insert(agents).values({id:actor.id,sessionId:project.sessionId,userId,workspaceId,role:'qa',status:'running'});
 const verified=await tools.getTool('verify_incident')!.execute({id:goalId,incidentId:incident.id,command:'test -f runtime-sdk',cwd:root},actor) as {passed:boolean;evidenceId:string};
 expect(verified.passed).toBe(true);
 expect(await repo.advanceIncident(goalId,incident.id,{expectedRevision:2,evidenceId:verified.evidenceId})).toMatchObject({state:'resolved'});
 const continuation=await repo.queueMessage(goalId,{requestKey:randomUUID(),sessionId:project.sessionId,message:'Continue the original milestone from its saved checkpoint after verified runtime recovery.'});
 expect(continuation.sessionId).toBe(project.sessionId);
 expect((await repo.read(goalId)).links.filter(link=>link.sessionId===project.sessionId)).toHaveLength(1);
});

test('bounded source paging retrieves every original request character and acceptance criterion',async()=>{
 const {CompanionSupervisionRepository}=await import('@/db/repositories/companion-supervision-repository');const repo=new CompanionSupervisionRepository({userId,workspaceId});
 const request='source words '.repeat(1500).trim();const criteria=Array.from({length:50},(_,index)=>`criterion ${index}`);
 const goal=await repo.create({requestKey:randomUUID(),title:'Full source retention',request,outcome:'Preserve every criterion',acceptanceCriteria:criteria});
 const {CompanionTool}=await import('@/tools/companion');const tools=new CompanionTool();await tools.initialize();
 let collected='';for(let offset=0;offset<request.length;offset+=4000){const page=await tools.getTool('read_part')!.execute({id:goal.id,field:'request',offset},context) as {value:string};collected+=page.value;}
 const all:string[]=[];for(let offset=0;offset<50;offset+=10){const page=await tools.getTool('read_part')!.execute({id:goal.id,field:'acceptanceCriteria',offset},context) as {value:string[]};all.push(...page.value);}
 expect(collected).toBe(request);expect(all).toEqual(criteria);
 await repo.update(goal.id,{expectedRevision:0,state:'cancelled'});
});

test.skipIf(!sandboxAvailable)('engine observes a persisted blocker after restart, repairs it and executes verified continuation without a browser',async()=>{
 const {getDb,closeDb,initializeDb}=await import('@/db/postgres');const {eq}=await import('drizzle-orm');
 const {agents}=await import('@/db/schema/agents');const {sessions}=await import('@/db/schema/sessions');
 await getDb().update(agents).set({status:'completed'});
 const projectRoot=join(dir,'engine-project');mkdirSync(projectRoot);
 const {refreshConfigKey}=await import('@/config');refreshConfigKey('workspace.additionalPaths',[projectRoot]);
 const {modelConfig}=await import('@/db/schema/models');await getDb().insert(modelConfig).values({name:'fixture-local',modelId:'fixture-qwen',provider:'ollama',supportsTools:true,isEnabled:true}).onConflictDoNothing();
 const {CompanionSupervisionRepository}=await import('@/db/repositories/companion-supervision-repository');const repo=new CompanionSupervisionRepository({userId,workspaceId});
 await repo.update(goalId,{expectedRevision:(await repo.read(goalId)).goal.revision,state:'cancelled'});
 const goal=await repo.create({requestKey:randomUUID(),title:'Engine-driven recovery',request:'Finish the milestone, repairing its runtime if needed',outcome:'Fresh gate and original milestone complete',acceptanceCriteria:['The runtime gate passes']});
 await repo.authorizeGoal(goal.id,{executionScope:'run',repoPath:projectRoot,overnight:true},0);
 const settings=await repo.readSettings();const {CompanionTool}=await import('@/tools/companion');const toolbox=new CompanionTool();await toolbox.initialize();
 const {getToolRegistry}=await import('@/tools/registry');const {ShellTool}=await import('@/tools/shell');if(!getToolRegistry().getToolHandlersForTools(['shell']).length)await getToolRegistry().register(new ShellTool());
 let continuations=0,acceptanceId:string|undefined;
 agentBoundary.handle.mockImplementation(async(sid:string,_uid:string,_message:string,_channel:string,_files:unknown,_mode:unknown,beforeStart:()=>Promise<void>)=>{
  await beforeStart();const id=`engine-${randomUUID()}`;
  await getDb().insert(agents).values({id,sessionId:sid,userId,workspaceId,status:'running',role:'general',model:'fixture-local',metadata:{root:true,...(_message.startsWith('SESSION BRIEFING')?{companionBriefing:true}:{})}});
  const [session]=await getDb().select().from(sessions).where(eq(sessions.id,sid));
  const actor={...context,id,sessionId:sid,metadata:{companionAuthorityRevision:settings.revision,...(session.context?.projectPath?{projectPath:session.context.projectPath}:{})}};
  const call=async(name:string,args:Record<string,unknown>)=>toolbox.getTool(name)!.execute(args,actor);
  let outcome='success',response='Inspected current durable work';
  try{
   if(sid===settings.supervisorSessionId){
    const detail=await repo.read(goal.id);const actions=await repo.actions(goal.id);
    const original=detail.links.find(link=>link.purpose===goal.outcome && link.origin==='created' && !actions.some(action=>action.sessionId===link.sessionId&&action.incidentId));
    if(!detail.links.length){await call('start_session',{id:goal.id,input:{requestKey:randomUUID(),expectedRevision:detail.goal.revision,modelName:'fixture-local',projectPath:projectRoot}});}
    else if(original&&actions.some(action=>action.status==='failed')){
     const incident=await repo.detectIncident(goal.id,original.sessionId);
     if(incident?.state==='observed'){
      await call('advance_incident',{id:goal.id,incidentId:incident.id,expectedRevision:incident.revision,strategy:'Restore the runtime prerequisite through configured maintenance and verify the original sandbox'});
      await call('start_maintenance',{id:goal.id,input:{requestKey:randomUUID(),expectedRevision:(await repo.read(goal.id)).goal.revision,modelName:'fixture-local'}});
     }else if(incident?.state==='repairing'&&actions.some(action=>action.incidentId===incident.id&&action.status==='completed')){
      const proof=await call('verify_incident',{id:goal.id,incidentId:incident.id,command:'test -f engine-sdk',cwd:projectRoot}) as {evidenceId:string;passed:boolean};expect(proof.passed).toBe(true);
      await call('advance_incident',{id:goal.id,incidentId:incident.id,expectedRevision:incident.revision+1,evidenceId:proof.evidenceId});
      await call('request_briefing',{id:goal.id,requestKey:randomUUID(),sessionId:original.sessionId});
     }else if(incident?.state==='resolved'&&!acceptanceId){
      const brief=actions.find(action=>action.kind==='request_briefing'&&action.sessionId===original.sessionId&&action.status==='completed');
      if(brief&&!actions.some(action=>action.kind==='message_session'))await call('message_session',{id:goal.id,input:{requestKey:randomUUID(),sessionId:original.sessionId,briefingId:brief.id,message:'Continue the original milestone after the verified runtime repair.'}});
     }else if(acceptanceId&&actions.every(action=>!['queued','running','unknown'].includes(action.status))){
      await call('update',{id:goal.id,input:{expectedRevision:detail.goal.revision,state:'completed',evidence:[{criterionIndex:0,evidenceId:acceptanceId,summary:'Fresh registered runtime gate passed after recovery'}]}});
     }
    }
   }else if(_message.startsWith('SESSION BRIEFING')){
    response='Architecture: existing project runtime in its approved checkout; SDK prerequisite is restored. No implementation executed in this briefing.';
   }else if(session.context?.companionMaintenance){
    const {runMaintenance}=await import('./maintenance');const result=await runMaintenance(actor,{command:'touch engine-sdk',cwd:projectRoot});expect(result.exitCode).toBe(0);response='Runtime prerequisite restored';
   }else{
    const run=getToolRegistry().getToolHandlersForTools(['shell']).find(tool=>tool.name==='shell__run')!;
    const result=await run.execute({command:'test -f engine-sdk',cwd:projectRoot},actor) as {exitCode:number};
    if(result.exitCode!==0){outcome='error';response='SDK location not found';await getDb().update(agents).set({error:response}).where(eq(agents.id,id));}
    else{continuations++;const {verificationEvidenceRepository}=await import('@/db/repositories/verification-evidence-repository');const evidence=await verificationEvidenceRepository.record({sessionId:sid,kind:'pre_verify',passed:true,detail:{checkScope:`goal:${goal.id}`,command:'test -f engine-sdk',exitCode:0}});acceptanceId=evidence.id;response='Original milestone completed with a fresh passing runtime gate';}
   }
   return {outcome,response};
  }finally{await getDb().update(agents).set({status:outcome==='success'?'completed':'failed',completedAt:new Date()}).where(eq(agents.id,id));}
 });
 const {CompanionDispatcher}=await import('./dispatcher');let dispatcher=new CompanionDispatcher();
 await vi.waitFor(async()=>{await dispatcher.tick();expect((await repo.actions(goal.id)).some(action=>action.status==='failed')).toBe(true);},{timeout:10000,interval:30});
 const {companionWakes}=await import('@/db/schema/companion-supervision');await vi.waitFor(async()=>{const live=await getDb().select().from(companionWakes).where(eq(companionWakes.status,'running'));expect(live).toHaveLength(0);});
 await closeDb();await initializeDb();dispatcher=new CompanionDispatcher();
 await vi.waitFor(async()=>{await dispatcher.tick();expect((await repo.read(goal.id)).goal.state).toBe('completed');},{timeout:15000,interval:30});
 expect(continuations).toBe(1);expect((await repo.incidents(goal.id))[0].state).toBe('resolved');
 expect((await repo.read(goal.id)).links).toHaveLength(2);
 expect(agentBoundary.publish).toHaveBeenCalled();
 agentBoundary.handle.mockReset();
});

test('activation completion atomically retains captured resume intent across another restart',async()=>{
 const {getDb,closeDb,initializeDb}=await import('@/db/postgres');const {eq}=await import('drizzle-orm');
 const {CompanionSupervisionRepository}=await import('@/db/repositories/companion-supervision-repository');const repo=new CompanionSupervisionRepository({userId,workspaceId});
 const goal=await repo.create({requestKey:randomUUID(),title:'Activation recovery',request:'Preserve and continue the captured pipeline',outcome:'Captured work continued',acceptanceCriteria:['Run complete']});
 const work=await repo.startSession(goal.id,{requestKey:randomUUID(),expectedRevision:0,modelName:'fixture-local',projectPath:root});
 const settings=await repo.readSettings();const {maintenanceRuntime}=await import('./maintenance');const binding=maintenanceRuntime({userId,workspaceId}).binding;
 const maintenance=await repo.startSession(goal.id,{requestKey:randomUUID(),expectedRevision:1,modelName:'fixture-local'},true,binding);
 const {pipelineRepository}=await import('@/db/repositories/pipeline-repository');
 const run=await pipelineRepository.create({userId,workspaceId,sessionId:work.sessionId,rootAgentId:'activation-fixture',title:'Captured run',type:'development',status:'paused'});
 const {companionActivations,companionActions}=await import('@/db/schema/companion-supervision');const id=randomUUID();
 await getDb().insert(companionActivations).values({id,goalId:goal.id,sessionId:maintenance.sessionId,requestKey:randomUUID(),authorityRevision:settings.revision,binding,root,status:'launched',resumeIds:[run.id],resumeGenerations:{[run.id]:''}});
 const stateDir=join(process.env.OCTIPUS_STATE_DIR!,'companion-activation');mkdirSync(stateDir,{recursive:true});writeFileSync(join(stateDir,`${id}.json`),JSON.stringify({id,status:'restarted',result:'Fixture external launcher completed'}));
 await(await import('./activation')).tickCompanionActivation();await closeDb();await initializeDb();
 const receipts=await getDb().select().from(companionActions).where(eq(companionActions.pipelineId,run.id));
 expect(receipts).toHaveLength(1);expect(receipts[0]).toMatchObject({kind:'resume_pipeline',status:'queued',sessionId:work.sessionId});
 await(await import('./activation')).tickCompanionActivation();expect(await getDb().select().from(companionActions).where(eq(companionActions.pipelineId,run.id))).toHaveLength(1);
 const current=await repo.read(goal.id);await repo.update(goal.id,{expectedRevision:current.goal.revision,state:'cancelled'});
});

test('activation admission gate blocks new agents and pipeline resumes until the handoff is reconciled',async()=>{
 const {getDb}=await import('@/db/postgres');const {companionActivations}=await import('@/db/schema/companion-supervision');
 const {agents}=await import('@/db/schema/agents');const {eq}=await import('drizzle-orm');
 const id=randomUUID();await getDb().insert(companionActivations).values({id,goalId,sessionId,requestKey:randomUUID(),authorityRevision:1,binding:'fixture',root,status:'launched'});
 await expect(getDb().insert(agents).values({id:'blocked-during-activation',sessionId,userId,workspaceId,status:'running'})).rejects.toThrow();
 await getDb().update(companionActivations).set({status:'reconciled'}).where(eq(companionActivations.id,id));
 await getDb().insert(agents).values({id:'admitted-after-activation',sessionId,userId,workspaceId,status:'running'});
 const [admitted]=await getDb().select({id:agents.id}).from(agents).where(eq(agents.id,'admitted-after-activation'));expect(admitted.id).toBe('admitted-after-activation');
});

test('runtime revocation takes effect before another host command',async()=>{
 const {refreshConfigKey}=await import('@/config');refreshConfigKey('security.companionMaintenance',{enabled:false,userId,roots:[dir],hostServices:false,sshAgent:false,allowActivation:false,interruptionPolicy:'wait'});
 const {runMaintenance}=await import('./maintenance');await expect(runMaintenance(context,{command:'touch must-not-run',cwd:outside})).rejects.toThrow('Configure');
 const {existsSync}=await import('node:fs');expect(existsSync(join(outside,'must-not-run'))).toBe(false);
 expect(goalId).toBeTruthy();
});
