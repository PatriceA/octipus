import { expect, test, vi } from 'vitest';
vi.mock('./service',()=>({grantedHostScopes:(r:{manifest:{host?:string[]};approvedHostScopes?:string[]})=>(r.manifest.host??[]).filter(s=>r.approvedHostScopes?.includes(s)),effectiveMaxProtection:()=>1}));
import { approvedProtectionLevel, configurableProtectionMaximum, trustedProtectionConnection } from './protection-policy';
import type { PluginManifest } from '@/shared/plugin-package';
import type { PluginProtectionApproval } from '@/shared/plugin-protection';
const manifest:PluginManifest={name:'some-audit',title:'Audit',description:'Generic',version:'1.0.0',apiVersion:'1.2.0',maxProtection:1,host:['repos:collect','store:read','store:write'],ui:{pages:[{path:'audit',title:'Audit',entry:'index.html'}]}};
const hash=`sha256:${'a'.repeat(64)}`;
const approval:PluginProtectionApproval={contentHash:hash,level:2,connections:[{id:'tracker',origin:'https://example.com',pathPrefix:'/api'}],approvedBy:'owner',approvedAt:'2026-11-18T00:00:00Z'};
const row={name:manifest.name,manifest,contentHash:hash,approvedHostScopes:manifest.host!};
test('an owner can approve Internal without changing the manifest or signed bytes',()=>{
 expect(approvedProtectionLevel(row,null)).toBe(1);
 expect(approvedProtectionLevel(row,approval)).toBe(2);
 expect(manifest.maxProtection).toBe(1);
 expect(approvedProtectionLevel({...row,contentHash:`sha256:${'b'.repeat(64)}`},approval)).toBe(1);
});
test('bounded destinations support Internal; broader egress stays Public',()=>{
 expect(configurableProtectionMaximum(manifest,manifest.host!)).toBe(2);
 expect(configurableProtectionMaximum({...manifest,network:['example.com']},manifest.host!)).toBe(1);
 expect(configurableProtectionMaximum(manifest,['web:read'])).toBe(1);
 expect(configurableProtectionMaximum(manifest,['model:complete'])).toBe(1);
 expect(configurableProtectionMaximum({...manifest,ui:undefined,host:[]},[])).toBe(4);
});
test('connection trust is bound to its destination and path, not the reusable name',()=>{
 expect(trustedProtectionConnection(approval,{id:'tracker',http:{origin:'https://example.com',pathPrefix:'/api'}})).toBe(true);
 expect(trustedProtectionConnection(approval,{id:'tracker',http:{origin:'https://elsewhere.example.com',pathPrefix:'/api'}})).toBe(false);
 expect(trustedProtectionConnection(approval,{id:'tracker',http:{origin:'https://example.com',pathPrefix:'/'}})).toBe(false);
 expect(trustedProtectionConnection(approval,{id:'other',http:{origin:'https://example.com',pathPrefix:'/api'}})).toBe(false);
});
