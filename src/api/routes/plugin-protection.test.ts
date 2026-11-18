import { beforeEach, expect, test, vi } from 'vitest';
import { App } from '@/api/http';
import { principalFromUser } from '@/security/principal';
import type { PluginProtectionApproval } from '@/shared/plugin-protection';
const h=vi.hoisted(()=>({admin:true,scopes:null as string[]|null,approval:null as PluginProtectionApproval|null,calls:0,confirms:0,hash:`sha256:${'a'.repeat(64)}`}));
vi.mock('@/api/context',async()=>({apiContext:new (await import('@/api/http')).App().derive(()=>({user:{id:'owner',username:'owner',isAdmin:h.admin},principal:{...principalFromUser({id:'owner',username:'owner',isAdmin:h.admin}),...(h.scopes?{scopes:h.scopes}:{})}}))}));
vi.mock('@/db/repositories/plugin-protection-repository',()=>({pluginProtectionRepository:{get:async()=>h.approval,put:async(_name:string,value:PluginProtectionApproval)=>{h.calls++;h.approval=value;}}}));
vi.mock('@/plugins/packages/service',()=>({findRow:async()=>({name:'test-plugin',contentHash:h.hash,enabled:true,manifest:{name:'test-plugin',maxProtection:1,host:['repos:collect'],tools:{read_it:{effect:'read'},write_it:{effect:'write'}},settings:[]},settings:{},approvedHostScopes:['repos:collect']}),grantedHostScopes:()=>['repos:collect'],effectiveMaxProtection:()=>1,syncPluginServers:async()=>{},audit:async()=>{}}));
vi.mock('@/plugins/packages/read-level',()=>({resetReadLevels:async()=>{}}));
vi.mock('@/plugins/packages/run-check',()=>({packageRunProblem:async()=>null}));
vi.mock('@/plugins/packages/host-api',()=>({revokePluginTokens:()=>{}}));
vi.mock('@/security/credential-connections',()=>({readAvailableConnectionProfiles:async()=>[{id:'tracker',http:{origin:'https://example.com',pathPrefix:'/api'}}]}));
vi.mock('@/mcp/bridge',()=>({PLUGIN_SERVER_PREFIX:'plugin-',getMCPBridge:()=>({ensureConnected:async()=>{},getAllTools:()=>[{serverId:'plugin-test-plugin',name:'read_it',inputSchema:{type:'object'}}],callTool:async()=>{h.confirms++;return {content:[{type:'text',text:'{"ok":true}'}]};}})}));
import { pluginProtectionRoutes, protectedPluginRoutes } from './plugin-protection';
const app=new App().use(pluginProtectionRoutes).use(protectedPluginRoutes);
const request=(path:string,body?:unknown,method=body?'PUT':'GET')=>app.handle(new Request('http://localhost'+path,{method,...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})}));
beforeEach(()=>{h.admin=true;h.scopes=null;h.approval=null;h.calls=0;h.confirms=0;});
test('an ordinary user can use protected tools but cannot approve their own data access',async()=>{
 h.admin=false;
 expect((await request('/plugin-packages/test-plugin/protection',{contentHash:h.hash,level:2,connections:['tracker']})).status).toBe(403);
 expect(h.calls).toBe(0);
 expect((await request('/plugins/test-plugin/protected')).status).toBe(200);
});
test('read-scoped tokens and stale package hashes cannot change approval',async()=>{
 h.scopes=['api:read'];
 expect((await request('/plugin-packages/test-plugin/protection',{contentHash:h.hash,level:2,connections:['tracker']})).status).toBe(403);
 h.scopes=null;
 expect((await request('/plugin-packages/test-plugin/protection',{contentHash:`sha256:${'b'.repeat(64)}`,level:2,connections:['tracker']})).status).toBe(409);
 expect(h.calls).toBe(0);
});
test('Internal approval requires known trusted destinations and pins their metadata',async()=>{
 expect((await request('/plugin-packages/test-plugin/protection',{contentHash:h.hash,level:2,connections:[]})).status).toBe(409);
 expect((await request('/plugin-packages/test-plugin/protection',{contentHash:h.hash,level:2,connections:['unknown']})).status).toBe(409);
 const response=await request('/plugin-packages/test-plugin/protection',{contentHash:h.hash,level:2,connections:['tracker']});
 expect(response.status).toBe(200);
 expect(await response.json()).toMatchObject({allowedLevel:2});
 expect(h.approval).toMatchObject({contentHash:h.hash,connections:[{id:'tracker',origin:'https://example.com',pathPrefix:'/api'}]});
});
test('native calls only dispatch declared tools and honor API write scopes',async()=>{
 expect((await request('/plugins/test-plugin/protected/call/missing',{args:{}},'POST')).status).toBe(404);
 h.scopes=['api:read'];
 expect((await request('/plugins/test-plugin/protected/call/write_it',{args:{}},'POST')).status).toBe(403);
 expect(h.confirms).toBe(0);
 expect((await request('/plugins/test-plugin/protected/call/read_it',{args:{}},'POST')).status).toBe(200);
 expect(h.confirms).toBe(1);
});
