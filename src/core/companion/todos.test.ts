import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,test,vi} from 'vitest';
import type {AgentContext} from '@/core/types';
const boundary=vi.hoisted(()=>({spawn:vi.fn()}));
vi.mock('@/core/agent',()=>({getAgentService:()=>({spawnWorker:boundary.spawn})}));
const random=()=>randomBytes(24).toString('hex');
process.env.MASTER_KEY??=`test-master-${random()}`;process.env.JWT_SECRET??=`test-jwt-${random()}`;process.env.SESSION_SECRET??=`test-session-${random()}`;
process.env.STORAGE_MODE='embedded';const dir=mkdtempSync(join(tmpdir(),'octipus-companion-todos-'));process.env.DATA_DIR=dir;process.env.LOG_LEVEL='error';
const userId=randomUUID(),otherUser=randomUUID();let workspaceId:string,sharedId:string,sessionId:string,context:AgentContext;
let companion:import('@/tools/companion').CompanionTool,board:import('@/tools/tasks').TasksTool;
beforeAll(async()=>{
 const {initializeDb,getDb}=await import('@/db/postgres');await initializeDb();await(await import('@/db/migrate')).runMigrations();
 await(await import('@/test-helpers/multiuser-fixtures')).seedUsers([{id:userId,username:'companion-todos'},{id:otherUser,username:'other-todos'}]);
 workspaceId=(await(await import('@/security/orgs')).getOrgWorkspaceManager().ensureDefaultWorkspace(userId)).id;
 const {workspaces}=await import('@/db/schema/organizations');sharedId=randomUUID();await getDb().insert(workspaces).values({id:sharedId,kind:'shared',userId:null,slug:'shared-todos',name:'Shared',filesDir:sharedId});
 const {sessions}=await import('@/db/schema/sessions');const [source]=await getDb().insert(sessions).values({userId,workspaceId,channelType:'webchat',channelId:'companion-todos',context:{companionSupervisor:{modelName:'fixture-local'}}}).returning();sessionId=source.id;
 const {CompanionTool}=await import('@/tools/companion');companion=new CompanionTool();await companion.initialize();
 const {TasksTool}=await import('@/tools/tasks');board=new TasksTool();await board.initialize();
 context={id:'todo-owner-turn',userId,workspaceId,sessionId,root:true,space:null,trigger:'user',funding:'own',role:'general',topic:'general',model:'fixture',status:'running',createdAt:new Date(),updatedAt:new Date(),metadata:{}};
 const {refreshConfigKey}=await import('@/config');refreshConfigKey('heartbeat.enabled',false);
},120000);
afterAll(async()=>{await(await import('@/core/tasks/wakeups')).flushWakeups();await(await import('@/db/postgres')).closeDb();rmSync(dir,{recursive:true,force:true});});
const status=(ctx=context)=>companion.getTool('heartbeat_status')!.execute({role:'general'},ctx) as Promise<{heartbeatEnabled:boolean;roleEnabled:boolean;boardWritesAllowed:boolean;readyForEligibleHeartbeat:boolean}>;

test('Companion reports missing heartbeat, role and board-write prerequisites without enabling any of them',async()=>{
 expect(await status()).toMatchObject({heartbeatEnabled:false,roleEnabled:false,boardWritesAllowed:false,readyForEligibleHeartbeat:false});
 const {ensureRoleHeartbeatHook}=await import('@/core/heartbeat');await ensureRoleHeartbeatHook(userId,'general');
 const {refreshConfigKey}=await import('@/config');refreshConfigKey('heartbeat.enabled',true);
 expect(await status()).toMatchObject({heartbeatEnabled:true,roleEnabled:true,boardWritesAllowed:false,readyForEligibleHeartbeat:false});
 await(await import('@/security/permissions')).getPermissionManager().setPermission(userId,'tasks','write','ALLOW');
 expect(await status()).toMatchObject({readyForEligibleHeartbeat:true});
});

test('heartbeat status rejects shared and foreign workspace contexts',async()=>{
 await expect(status({...context,workspaceId:sharedId})).rejects.toThrow();
 await expect(status({...context,userId:otherUser})).rejects.toThrow();
});

test('parked protected idea waits on the board and reaches its next role turn with retained source protection',async()=>{
 const {raiseSessionLevel,sessionProtectionLevel}=await import('@/core/protection/session-level');const {observeFlow,getFlowLabel}=await import('@/security/flow-guard');
 raiseSessionLevel(sessionId,4);observeFlow(sessionId,{toolId:'fixture',action:'read'},{taints:['secret']});
 const result=await board.getTool('create_task')!.execute({title:'Explore this idea later',notes:'Keep these exact confidential words',assigneeKind:'role',assigneeRef:'general'},context) as {created:boolean;task:{id:string}};
 expect(result.created).toBe(true);expect(boundary.spawn).not.toHaveBeenCalled();
 const {getDb}=await import('@/db/postgres');const {tasks}=await import('@/db/schema/tasks');const {sessions}=await import('@/db/schema/sessions');const {hooks}=await import('@/db/schema/hooks');const {eq}=await import('drizzle-orm');
 const [task]=await getDb().select().from(tasks).where(eq(tasks.id,result.task.id));expect(task.sourceRef).toMatchObject({sessionId,protectionLevel:4,flowLabel:{secret:expect.any(String)}});
 // The board keeps the privacy snapshot even when its original conversation is gone.
 await getDb().delete(sessions).where(eq(sessions.id,sessionId));
 const heartbeat=await import('@/core/heartbeat');const [hook]=await getDb().select().from(hooks).where(eq(hooks.userId,userId));
 const {getConfig}=await import('@/config');const config={...getConfig().heartbeat,quietHoursStart:0,quietHoursEnd:0};
 const gate=await heartbeat.evaluateHeartbeatGate(hook,config,new Date());expect(gate.decision.run).toBe(true);expect(gate.taskProvenance).toMatchObject({protectionLevel:4});
 const trigger={message:{id:'parked-idea-heartbeat',userId,channelType:'api' as const,channelId:userId,content:gate.decision.run?gate.decision.message:'',timestamp:new Date()}};
 heartbeat.markHeartbeatGatePassed(trigger,gate.taskProvenance);
 boundary.spawn.mockImplementation(async(_role,_task,_input,actor:AgentContext)=>{
   const [target]=await getDb().select().from(sessions).where(eq(sessions.id,actor.sessionId));
   expect(target.protectionLevel).toBe(4);expect(sessionProtectionLevel(actor.sessionId)).toBe(4);expect(getFlowLabel(actor.sessionId).secret).toBe(true);
   return 'Work started in the correctly protected role turn';
 });
 const {executeAction}=await import('@/hooks/actions');expect(await executeAction(hook,trigger)).toMatchObject({success:true});expect(boundary.spawn).toHaveBeenCalledTimes(1);
});
