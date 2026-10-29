import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { MCPBridge } from './bridge';
import { resourceHandlers } from './resource-tools';
import { createCredentialTransport, assertCredentialConnectionAccess } from './credential-transport';
import type { AgentContext,MCPServer } from '@/core/types';
const fx=vi.hoisted(()=>({secret:'CANARY_MCP_SECRET_742!',reads:vi.fn(),allowedAgents:[] as string[]}));
vi.mock('@/security/vault',()=>({getVault:()=>({getByNameAuthorized:async(agent:{agentId?:string},_name:string,options?:{trustedMcpTransport?:boolean})=>{if(fx.allowedAgents.length&&!options?.trustedMcpTransport&&!fx.allowedAgents.includes(agent.agentId??''))return null;fx.reads();return fx.secret;}})}));
let dir:string;const saved=process.env.OCTIPUS_CONNECTIONS_FILE;let stop:(()=>Promise<void>)|undefined;
beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),'octi-mcp-credential-'));process.env.OCTIPUS_CONNECTIONS_FILE=join(dir,'profiles.json');fx.secret='CANARY_MCP_SECRET_742!';fx.allowedAgents=[];fx.reads.mockClear();});
afterEach(async()=>{await stop?.();stop=undefined;if(saved===undefined)delete process.env.OCTIPUS_CONNECTIONS_FILE;else process.env.OCTIPUS_CONNECTIONS_FILE=saved;await rm(dir,{recursive:true,force:true});});
const context={userId:'alice',workspaceId:'w',id:'a'} as AgentContext;
it('authenticates remote MCP in its transport, redacts replies, and rejects cross-workspace dispatch',async()=>{
 const server=createServer(async(req,res)=>{expect(req.headers['x-api-key']).toBe(fx.secret);for await(const _c of req){}res.setHeader('Content-Type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:fx.secret+' '+Buffer.from(fx.secret).toString('base64')}]}}));});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));stop=async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));};
 const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 await writeFile(process.env.OCTIPUS_CONNECTIONS_FILE!,JSON.stringify([{id:'mcp',userId:'alice',workspaceId:'w',credential:'MCP_TOKEN',http:{origin,allowInsecureHttp:true,auth:{type:'header',name:'X-API-Key'},methods:['POST'],mcpServers:['remote']}}]),{mode:0o600});
 const cfg:MCPServer={id:'remote',name:'remote',command:'',isEnabled:true,transport:'streamable-http',sseUrl:origin+'/mcp',credentialConnection:'mcp'};
 await assertCredentialConnectionAccess(cfg,context);
 for(const c of [{...context,workspaceId:'other'},{...context,userId:'bob'},undefined])await expect(assertCredentialConnectionAccess(cfg,c)).rejects.toThrow(/unavailable/);
 fx.allowedAgents=['a'];
 const transport=await createCredentialTransport(cfg);await transport.connect();
 await expect(assertCredentialConnectionAccess(cfg,{...context,id:'b'})).rejects.toThrow(/denied/);
 try{const result=new Promise<string>((resolve,reject)=>{transport.onMessage(resolve);transport.onError(reject);});transport.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'sample'}}));const text=await result;expect(text).toContain('REDACTED');expect(text).not.toContain(fx.secret);expect(text).not.toContain(Buffer.from(fx.secret).toString('base64'));}finally{transport.close();}
 await expect(createCredentialTransport({...cfg,sseUrl:'https://other.test/mcp'})).rejects.toThrow(/origin/);
});
it('binds stdio credentials to the exact configured executable and args, masking stdout/stderr',async()=>{
 const script=join(dir,'server.mjs');await writeFile(script,`console.error(process.env.TEST_AUTH);console.log(JSON.stringify({result:process.env.TEST_AUTH}));`);
 await writeFile(process.env.OCTIPUS_CONNECTIONS_FILE!,JSON.stringify([{id:'local',userId:'alice',workspaceId:'w',credential:'MCP_TOKEN',stdio:[{serverId:'local',command:process.execPath,args:[script],envName:'TEST_AUTH',cwd:dir,env:{}}]}]),{mode:0o600});
 const cfg:MCPServer={id:'local',name:'local',command:process.execPath,args:[script],isEnabled:true,credentialConnection:'local'};
 const transport=await createCredentialTransport(cfg);const errors:string[]=[];
 const result=new Promise<string>(resolve=>transport.onMessage(resolve));transport.onError(e=>errors.push(e.message));
 await transport.connect();try{expect(await result).not.toContain(fx.secret);expect(errors.join()).not.toContain(fx.secret);}finally{transport.close();}
 const reads=fx.reads.mock.calls.length;
 await expect(createCredentialTransport({...cfg,args:[script,'different']})).rejects.toThrow(/executable/);
 await expect(createCredentialTransport({...cfg,env:{NODE_OPTIONS:'--require=/untrusted/leak.js'}})).rejects.toThrow(/environment/);
 await expect(createCredentialTransport({...cfg,cwd:dir+'/untrusted'})).rejects.toThrow(/cwd/);
 expect(fx.reads.mock.calls.length).toBe(reads);
 fx.secret='ROTATED_MCP_CREDENTIAL';await expect(assertCredentialConnectionAccess(cfg,context)).rejects.toThrow(/rotated/);
});

it('keeps credential-bound tools, resources and prompts out of other principals and global advertisements',async()=>{
 await writeFile(process.env.OCTIPUS_CONNECTIONS_FILE!,JSON.stringify([{id:'private',userId:'alice',workspaceId:'w',credential:'MCP_TOKEN',http:{origin:'https://private.example.test',auth:{type:'bearer'},methods:['POST'],mcpServers:['private']}}]),{mode:0o600});
 const bridge=new MCPBridge();
 const server:MCPServer={id:'private',name:'Private server',command:'',transport:'streamable-http',sseUrl:'https://private.example.test/mcp',isEnabled:true,credentialConnection:'private'};
 const connection={id:server.id,server,status:'connected',tools:[{name:'private_tool',description:'PRIVATE_METADATA',inputSchema:{type:'object'}}],resources:[{uri:'private://secret',name:'PRIVATE_METADATA'}],templates:[],prompts:[{name:'PRIVATE_METADATA'}]};
 (bridge as unknown as {connections:Map<string,unknown>}).connections.set(server.id,connection);
 expect(bridge.getToolHandlers()).toEqual([]);expect(bridge.getScriptTools()).toEqual([]);
 const list=bridge.getLazyToolHandlers().find(t=>t.name==='mcp_list_tools')!;
 const resources=resourceHandlers(bridge).find(t=>t.name==='mcp_list_resources')!;
 for(const c of [{...context,userId:'bob'},{...context,workspaceId:'other'}]){
  expect(JSON.stringify(await list.execute({},c))).not.toContain('PRIVATE_METADATA');
  expect(JSON.stringify(await resources.execute({},c))).not.toContain('PRIVATE_METADATA');
 }
 expect(JSON.stringify(await list.execute({},context))).toContain('private_tool');
 expect(JSON.stringify(await resources.execute({},context))).toContain('PRIVATE_METADATA');
});

it('aborts credential-bearing MCP HTTP when the caller cancels, without assuming a sent operation had no effect',async()=>{
 let received!:()=>void;const started=new Promise<void>(r=>{received=r;});
 let closed!:()=>void;const cancelled=new Promise<void>(r=>{closed=r;});
 const server=createServer(async(req,res)=>{for await(const _c of req){}res.on('close',()=>closed());received();});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));stop=async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));};
 const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 await writeFile(process.env.OCTIPUS_CONNECTIONS_FILE!,JSON.stringify([{id:'cancel',userId:'alice',workspaceId:'w',credential:'MCP_TOKEN',http:{origin,allowInsecureHttp:true,auth:{type:'bearer'},methods:['POST'],mcpServers:['cancel']}}]),{mode:0o600});
 const transport=await createCredentialTransport({id:'cancel',name:'cancel',command:'',isEnabled:true,transport:'streamable-http',sseUrl:origin+'/mcp',credentialConnection:'cancel'});
 await transport.connect();const abort=new AbortController();const failure=new Promise<Error>(resolve=>transport.onError(resolve));
 try{transport.send(JSON.stringify({id:1,method:'tools/call'}),abort.signal);await started;abort.abort();expect((await failure).message).toMatch(/request failed/);await cancelled;}finally{transport.close();}
});

it('keeps a healthy persistent SSE listener open past the POST request deadline', async () => {
  const server=createServer((req,res)=>{if(req.url==='/sse'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: '+JSON.stringify({ready:true})+'\n\n');}else res.end();});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));stop=async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));};
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  await writeFile(process.env.OCTIPUS_CONNECTIONS_FILE!,JSON.stringify([{id:'sse',userId:'alice',workspaceId:'w',credential:'MCP_TOKEN',http:{origin,allowInsecureHttp:true,auth:{type:'bearer'},methods:['GET','POST'],mcpServers:['sse']}}]),{mode:0o600});
  const transport=await createCredentialTransport({id:'sse',name:'sse',command:'',isEnabled:true,transport:'sse',sseUrl:origin+'/sse',postUrl:origin+'/messages',credentialConnection:'sse',requestTimeoutMs:50});
  const errors:string[]=[];const frames:string[]=[];transport.onError(e=>errors.push(e.message));transport.onMessage(m=>frames.push(m));
  await transport.connect();try{await new Promise(r=>setTimeout(r,150));expect(frames).toContain(JSON.stringify({ready:true}));expect(errors).toEqual([]);}finally{transport.close();}
});
