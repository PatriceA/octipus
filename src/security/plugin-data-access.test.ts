import { beforeEach,expect,test,vi } from 'vitest';
import type { PluginProtectionApproval } from '@/shared/plugin-protection';
const h=vi.hoisted(()=>({level:2,cap:1,stamp:undefined as string|undefined,approval:null as PluginProtectionApproval|null,syncs:0}));
vi.mock('@/db/repositories/plugin-protection-repository',()=>({pluginProtectionRepository:{get:async()=>h.approval}}));
vi.mock('@/core/protection/routing',()=>({carriedLevel:async()=>h.level}));
vi.mock('@/mcp/bridge',()=>({getMCPBridge:()=>({pluginMaxProtection:()=>h.cap,getServerConfigs:()=>[{id:'plugin-generic',plugin:{dataApproval:h.stamp}}]})}));
vi.mock('@/plugins/packages/service',()=>({effectiveMaxProtection:()=>1,grantedHostScopes:()=>[],syncPluginServers:async()=>{h.syncs++;h.cap=h.approval?.level??1;h.stamp=protectionApprovalStamp(h.approval);}}));
import { protectionApprovalStamp } from '@/plugins/packages/protection-policy';
import { pluginProtectionRefusal } from './mcp-authorization';
beforeEach(()=>{h.level=2;h.cap=1;h.stamp=undefined;h.approval=null;h.syncs=0;});
test('an existing level-2 conversation works after owner approval; its classification stays level 2',async()=>{
 expect(await pluginProtectionRefusal('existing-session','plugin-generic')).toContain('Data access');
 h.approval={contentHash:`sha256:${'a'.repeat(64)}`,level:2,connections:[],approvedBy:'owner',approvedAt:new Date().toISOString()};
 expect(await pluginProtectionRefusal('existing-session','plugin-generic')).toBeUndefined();
 expect(h.level).toBe(2);expect(h.syncs).toBe(1);
});
test('a policy reduction refreshes a stale instance before it dispatches sensitive arguments',async()=>{
 h.approval={contentHash:`sha256:${'a'.repeat(64)}`,level:1,connections:[],approvedBy:'owner',approvedAt:new Date().toISOString()};h.cap=2;h.stamp='old-approval';
 expect(await pluginProtectionRefusal('existing-session','plugin-generic')).toContain('up to level 1');
 expect(h.syncs).toBe(1);expect(h.level).toBe(2);
});
