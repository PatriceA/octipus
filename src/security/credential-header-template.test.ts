import {createServer} from 'node:http';
import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {authenticatedFetch,connectionProfileSchema,type ConnectionProfile,readBoundedResponse} from './credential-connections';
import {apiConnectionSchema} from '@/shared/api-connection';
import {headerTemplateReferences,renderHeaderTemplate} from '@/shared/header-template';
import {assertNoCredentialTemplates} from './credential-boundary';
const fx=vi.hoisted(()=>({reads:vi.fn(),denied:new Set<string>(),values:new Map<string,string>()}));
vi.mock('./vault',()=>({getVault:()=>({getByNameAuthorized:async(principal:unknown,name:string)=>{fx.reads(principal,name);return fx.denied.has(name)?null:fx.values.get(name)??null;}})}));
let server:ReturnType<typeof createServer>,profile:ConnectionProfile,requests=0;
const caller={userId:'owner',workspaceId:'w1',agentId:'agent'};
const template='PVEAPIToken=<PROXMOX_TOKEN_ID>=<PROXMOX_SECRET>';
beforeEach(async()=>{
 fx.reads.mockClear();fx.denied.clear();fx.values=new Map([['PROXMOX_TOKEN_ID','canary-user@pve!canary-token'],['PROXMOX_SECRET','canary-secret-value']]);requests=0;
 server=createServer((req,res)=>{requests++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:fx.values.get('PROXMOX_TOKEN_ID'),secret:fx.values.get('PROXMOX_SECRET'),header:req.headers.authorization,joined:Buffer.from(`${fx.values.get('PROXMOX_TOKEN_ID')}=${fx.values.get('PROXMOX_SECRET')}`).toString('base64')}));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 profile=connectionProfileSchema.parse({id:'proxmox',userId:'owner',workspaceId:null,credential:'PROXMOX_SECRET',http:{origin,auth:{type:'header-template',name:'Authorization',template},methods:['GET'],allowInsecureHttp:true,pathPrefix:'/api2/json'}});
});
afterEach(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
test('resolves two exact named vault entries only inside the approved HTTP client and masks both values and the composite header',async()=>{
 const result=await authenticatedFetch(profile,caller,'/api2/json/nodes');const raw=JSON.parse(await readBoundedResponse(result.response));
 expect(raw.header).toBe(`PVEAPIToken=${fx.values.get('PROXMOX_TOKEN_ID')}=${fx.values.get('PROXMOX_SECRET')}`);
 const safe=JSON.stringify(result.mask(raw));for(const value of [...fx.values.values(),raw.header,raw.joined])expect(safe).not.toContain(value);
 expect(fx.reads.mock.calls.map(call=>call[1])).toEqual(['PROXMOX_SECRET','PROXMOX_TOKEN_ID']);
 for(const call of fx.reads.mock.calls)expect(call[0]).toEqual({userId:'owner',workspaceId:null,toolId:'connections',agentId:'agent'});
 const first=result.credentialVersion;fx.values.set('PROXMOX_TOKEN_ID','different-user@pve!other');expect((await authenticatedFetch(profile,caller,'/api2/json/nodes')).credentialVersion).not.toBe(first);
});
test('denied, missing or expired component stops the request without transmitting either credential',async()=>{
 for(const name of ['PROXMOX_TOKEN_ID','PROXMOX_SECRET']){
 fx.denied.add(name);await expect(authenticatedFetch(profile,caller,'/api2/json/nodes')).rejects.toThrow('credential unavailable');fx.denied.clear();
 }
 fx.values.delete('PROXMOX_TOKEN_ID');await expect(authenticatedFetch(profile,caller,'/api2/json/nodes')).rejects.toThrow('credential unavailable');expect(requests).toBe(0);
});
test('owner/space, path/method and selected-entry binding checks happen before any credential read',async()=>{
 for(const principal of [{...caller,userId:'foreign'},{...caller,space:{id:'shared'}}])await expect(authenticatedFetch(profile,principal,'/api2/json/nodes')).rejects.toThrow('access denied');
 await expect(authenticatedFetch(profile,caller,'/outside')).rejects.toThrow('outside');await expect(authenticatedFetch(profile,caller,'/api2/json/nodes',{method:'POST'})).rejects.toThrow('method');
 profile.credential='UNRELATED';await expect(authenticatedFetch(profile,caller,'/api2/json/nodes')).rejects.toThrow('must reference');expect(fx.reads).not.toHaveBeenCalled();expect(requests).toBe(0);
});
test('header overrides and control characters cannot escape authentication handling or expose secret values',async()=>{
 await expect(authenticatedFetch(profile,caller,'/api2/json/nodes',{headers:{Authorization:'override'}})).rejects.toThrow('controlled');
 fx.values.set('PROXMOX_TOKEN_ID','canary-private\r\nHost: evil.test');
 let error;try{await authenticatedFetch(profile,caller,'/api2/json/nodes');}catch(e){error=e;}expect(String(error)).toContain('Invalid connection authentication');expect(String(error)).not.toContain('canary-private');expect(requests).toBe(0);
});
test('the syntax is literal, bounded and non-recursive; unrelated interpolation stays prohibited',()=>{
 expect(headerTemplateReferences(template)).toEqual(['PROXMOX_TOKEN_ID','PROXMOX_SECRET']);
 expect(renderHeaderTemplate('<A>=<B>',new Map([['A','$&<C>'],['B','literal']]))).toBe('$&<C>=literal');
 for(const invalid of ['<A>','<A>=<A>','<A>=<B>=<C>','<<A>>=<B>','< A>=<B>','{{secret:A}}=<A>=<B>','${vault.A}=<A>=<B>','<A>\n<B>'])expect(()=>headerTemplateReferences(invalid)).toThrow();
 const config={id:'two-refs',origin:'https://api.example.test',methods:['GET'],auth:{type:'header-template',name:'Authorization',template}};
 expect(apiConnectionSchema.safeParse(config).success).toBe(true);
 for(const name of ['Host','Cookie','Proxy-Authorization','Content-Length'])expect(apiConnectionSchema.safeParse({...config,auth:{...config.auth,name}}).success).toBe(false);
 expect(()=>assertNoCredentialTemplates({command:'echo {{secret:PROXMOX_SECRET}}'})).toThrow();
});
