import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { authenticatedGit } from './credential-git';
import { connectionProfileSchema } from './credential-connections';
const fx=vi.hoisted(()=>({secret:'CANARY_GIT_PASSWORD_39x!',spawns:[] as unknown[]}));
vi.mock('./vault',()=>({getVault:()=>({getByNameAuthorized:async()=>fx.secret})}));
vi.mock('node:child_process',async original=>{const actual=await original<typeof import('node:child_process')>();return {...actual,spawn:(...args: Parameters<typeof actual.spawn>)=>{fx.spawns.push(args);return actual.spawn(...args);}};});
let dir='';let stop:(()=>Promise<void>)|undefined;
afterEach(async()=>{await stop?.();stop=undefined;if(dir)await rm(dir,{recursive:true,force:true});});
const caller={userId:'alice',workspaceId:'w',agentId:'a'};
it('fetches and pushes through the broker; the Git child and persisted Git files never receive the credential',async()=>{
 dir=await mkdtemp(join(tmpdir(),'octi-auth-git-'));fx.spawns=[];
 const remote=join(dir,'remote.git'),source=join(dir,'source'),local=join(dir,'local');
 const run=(cwd:string,args:string[])=>execFileSync('git',args,{cwd,env:{PATH:process.env.PATH,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null'},stdio:'pipe'}).toString();
 await mkdir(source);await mkdir(local);run(dir,['init','--bare',remote]);run(source,['init']);run(local,['init']);
 run(source,['-c','user.name=Test','-c','user.email=test@example.test','commit','--allow-empty','-m','seed']);run(source,['push',remote,'HEAD:refs/heads/main']);
 const server=createServer(async(req,res)=>{
  if(req.headers.authorization!==`Basic ${Buffer.from('oauth2:'+fx.secret).toString('base64')}`){res.writeHead(401).end();return;}
  const u=new URL(req.url!,'http://local');const chunks:Buffer[]=[];for await(const c of req)chunks.push(c);
  const child=spawn('git',['http-backend'],{env:{PATH:process.env.PATH,GIT_PROJECT_ROOT:dir,GIT_HTTP_EXPORT_ALL:'1',REQUEST_METHOD:req.method!,PATH_INFO:u.pathname,QUERY_STRING:u.search.slice(1),CONTENT_TYPE:req.headers['content-type']??'',CONTENT_LENGTH:String(Buffer.concat(chunks).length),REMOTE_USER:'test'}});
  const output:Buffer[]=[];child.stdout.on('data',c=>output.push(c));child.stdin.end(Buffer.concat(chunks));
  child.once('close',()=>{const b=Buffer.concat(output);const i=b.indexOf('\r\n\r\n');if(i<0){res.writeHead(500).end();return;}
   for(const h of b.subarray(0,i).toString().split('\r\n')){const n=h.indexOf(':');if(n>0){if(h.slice(0,n).toLowerCase()==='status')res.statusCode=parseInt(h.slice(n+1));else res.setHeader(h.slice(0,n),h.slice(n+1).trim());}}
   res.end(b.subarray(i+4));});
 });await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));stop=async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));};
 const profile=connectionProfileSchema.parse({id:'git',userId:'alice',workspaceId:'w',credential:'GIT_TOKEN',http:{origin:`http://127.0.0.1:${(server.address() as {port:number}).port}`,allowInsecureHttp:true,auth:{type:'basic',username:'oauth2'},methods:['GET','POST'],git:true,repositoryRoots:[dir]}});
 // A repository-provided credential helper must never see the secret or run.
 const marker=join(dir,'helper-called');run(local,['config','credential.helper',`!echo leaked > '${marker}'`]);
 run(local,['config','url.http://127.0.0.1:1/.insteadOf','http://127.0.0.1:']);
 run(local,['config','http.proxy','http://127.0.0.1:1']);
 expect(await authenticatedGit(profile,caller,{operation:'fetch',path:local,remotePath:'/remote.git',refspecs:['refs/heads/main:refs/remotes/origin/main']})).toMatchObject({exitCode:0});
 expect(run(local,['rev-parse','refs/remotes/origin/main']).trim()).toBe(run(source,['rev-parse','HEAD']).trim());
 run(remote,['config','http.receivepack','true']);
 expect(await authenticatedGit(profile,caller,{operation:'push',path:local,remotePath:'/remote.git',refspecs:['refs/remotes/origin/main:refs/heads/verified']})).toMatchObject({exitCode:0});
 expect(run(remote,['rev-parse','refs/heads/verified']).trim()).toBe(run(source,['rev-parse','HEAD']).trim());
 expect(JSON.stringify(fx.spawns)).not.toContain(fx.secret);expect(JSON.stringify(fx.spawns)).not.toContain(Buffer.from('oauth2:'+fx.secret).toString('base64'));
 await expect(readFile(marker)).rejects.toThrow();
 for(const file of await readdir(join(local,'.git'))) {try{expect(await readFile(join(local,'.git',file),'utf8')).not.toContain(fx.secret);}catch(e){if((e as NodeJS.ErrnoException).code!=='EISDIR')throw e;}}
 await expect(authenticatedGit(profile,{...caller,workspaceId:'other'},{operation:'fetch',path:local,remotePath:'/remote.git',refspecs:['main']})).rejects.toThrow(/access denied/);
 await expect(authenticatedGit(profile,caller,{operation:'fetch',path:local,remotePath:'/remote.git',refspecs:['--upload-pack=evil']})).rejects.toThrow(/flags/);
},30_000);
