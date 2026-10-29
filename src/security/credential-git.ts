import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { realpath, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { relative, isAbsolute, join } from 'node:path';
import { spawn } from 'node:child_process';
import { buildIsolatedChildEnv } from './child-env';
import { killProcessTree } from '@/utils/proc';
import { authenticatedFetch, connectionUrl, principalCanUse, readBoundedResponse, type ConnectionProfile, type ConnectionPrincipal } from './credential-connections';

const nullFile = process.platform === 'win32' ? 'NUL' : '/dev/null';
async function gitCall(args: string[], cwd: string, signal: AbortSignal, input?: string, extraEnv: Record<string,string> = {}): Promise<{ stdout: string; stderr: string }> {
  // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- fixed executable, no shell, no credential in child environment
  const child = spawn('git', ['--no-replace-objects', '-c', `core.hooksPath=${nullFile}`, '-c', 'core.fsmonitor=false', ...args], {
    cwd, env: buildIsolatedChildEnv({ GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:nullFile, GIT_TERMINAL_PROMPT:'0', GIT_ASKPASS:'', SSH_ASKPASS:'', GIT_NO_LAZY_FETCH:'1', ...extraEnv }), stdio:['pipe','pipe','pipe'],
  });
  const stop=()=>killProcessTree(child.pid,child); signal.addEventListener('abort',stop,{once:true}); if(signal.aborted)stop();
  let stdout='',stderr='';child.stdout.on('data',c=>{stdout=(stdout+c).slice(-4*1024*1024);});child.stderr.on('data',c=>{stderr=(stderr+c).slice(-64_000);});
  child.stdin.on('error',()=>{});child.stdin.end(input);
  try {
    const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',()=>reject(new Error('Git executable could not start')));child.once('close',resolve);});
    if(code!==0 || signal.aborted)throw new Error(`Git operation failed${signal.aborted?' (cancelled or timed out)':''}: ${stderr}`);
    return {stdout,stderr};
  } finally {signal.removeEventListener('abort',stop);}
}
const refMap=(text:string)=>new Map(text.trim().split('\n').filter(Boolean).map(line=>{const [ref,hash]=line.split(' ');if(!/^refs\/[A-Za-z0-9_./-]+$/.test(ref)||! /^[a-f0-9]{40,64}$/.test(hash))throw new Error('Unsupported repository refs');return [ref,hash];}));

/** A short-lived, operation-bound Git HTTP broker. The Git process receives no vault value. */
export async function authenticatedGit(p: ConnectionProfile, caller: ConnectionPrincipal, args: {
  operation: 'fetch' | 'push'; timeout?: number; path: string; remotePath: string; refspecs: string[];
}, signal?: AbortSignal): Promise<unknown> {
  if (!principalCanUse(p, caller)) throw new Error('Connection access denied');
  if (!p.http?.git) throw new Error('Connection is not enabled for Git');
  const cwd = await realpath(args.path);
  const roots = await Promise.all(p.http.repositoryRoots.map(root => realpath(root)));
  if (!roots.some(root => { const rel = relative(root, cwd); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\'); })) throw new Error('Repository is outside the connection repository roots');
  if (!/^\/(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+\.git$/.test(args.remotePath)) throw new Error('Use a repository path such as /group/project.git');
  connectionUrl(p, args.remotePath);
  if (!args.refspecs.length || args.refspecs.some(ref => typeof ref !== 'string' || !ref || /^-/.test(ref) || /[\s\0-\x1f]/.test(ref))) throw new Error('Explicit Git refspecs are required; flags are not allowed');
  if (args.operation === 'fetch' && args.refspecs.some(ref => !/^\+?refs\/[A-Za-z0-9_./*-]+:refs\/(?:remotes|tags)\/[A-Za-z0-9_./*-]+$/.test(ref))) throw new Error('Fetch needs explicit refs/...:refs/remotes/... (or refs/tags/...) destinations');
  const service = args.operation === 'fetch' ? 'git-upload-pack' : 'git-receive-pack';
  const nonce = randomUUID();
  const prefix = `/${nonce}${args.remotePath}`;
  const timeoutMs=args.timeout??600_000;
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>1_800_000)throw new Error('Git timeout must be 1–1800000 milliseconds');
  const deadline = AbortSignal.timeout(timeoutMs);
  const lifetime = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let maskOutput: (value: unknown) => unknown = value => value;
  const server = createServer(async (req, res) => {
    try {
      const advertise = req.method === 'GET' && req.url === `${prefix}/info/refs?service=${service}`;
      const pack = req.method === 'POST' && req.url === `${prefix}/${service}`;
      if ((!advertise && !pack) || lifetime.aborted) { res.writeHead(403).end(); return; }
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 64 * 1024 * 1024) throw new Error('Git request too large');
        chunks.push(chunk);
      }
      const path = `${args.remotePath}${advertise ? `/info/refs?service=${service}` : `/${service}`}`;
      const { response, mask } = await authenticatedFetch(p, caller, path, {
        method: req.method, signal: lifetime,
        headers: pack ? { 'Content-Type': `application/x-${service}-request` } : {},
        body: pack ? Buffer.concat(chunks) : undefined,
      });
      const previousMask = maskOutput; maskOutput = value => mask(previousMask(value));
      if (!response.ok) {
        const diagnostic = mask((await readBoundedResponse(response)).slice(0, 4000));
        res.writeHead(502, { 'Content-Type': 'text/plain' }).end(`Git upstream returned ${response.status}: ${diagnostic}`);
        return;
      }
      const expected = `application/x-${service}-${advertise ? 'advertisement' : 'result'}`;
      if (response.headers.get('content-type')?.split(';')[0] !== expected) { await response.body?.cancel(); throw new Error('Invalid Git response'); }
      res.writeHead(200, { 'Content-Type': expected });
      const reader = response.body!.getReader(); let received = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          received += value.length;
          if (received > 512 * 1024 * 1024) throw new Error('Git response too large');
          if (!res.write(value)) await new Promise<void>((resolve, reject) => {
            res.once('drain', resolve); res.once('close', () => reject(new Error('Git client disconnected')));
          });
        }
        res.end();
      } finally { await reader.cancel().catch(() => {}); }
    } catch { if (!res.headersSent) res.writeHead(502).end('Authenticated Git transport failed'); else res.destroy(); }
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = (server.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}${prefix}`;
    // Network Git must never read the agent-writable repository configuration:
    // local URL rewrites, helpers, hooks or proxies cannot bypass the broker.
    const common = await realpath((await gitCall(['rev-parse','--path-format=absolute','--git-common-dir'],cwd,lifetime)).stdout.trim());
    const inside = (path:string) => roots.some(root=>{const rel=relative(root,path);return !isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('../')&&!rel.startsWith('..\\');});
    const objects = await realpath(join(common,'objects'));
    if (!inside(common)||!inside(objects)||!inside(await realpath(join(common,'refs')))) throw new Error('Git metadata is outside the approved repository roots');
    const format=(await gitCall(['rev-parse','--show-object-format'],cwd,lifetime)).stdout.trim();
    if(!['sha1','sha256'].includes(format))throw new Error('Unsupported Git object format');
    const before=refMap((await gitCall(['for-each-ref','--format=%(refname) %(objectname)'],cwd,lifetime)).stdout);
    const temporary=await mkdtemp(join(tmpdir(),'octipus-git-transport-'));
    try {
      await gitCall(['init','--bare',`--object-format=${format}`,temporary],temporary,lifetime);
      const env={GIT_OBJECT_DIRECTORY:objects};
      const clean=['--git-dir='+temporary];
      if(before.size)await gitCall([...clean,'update-ref','--stdin'],temporary,lifetime,[...before].map(([ref,hash])=>`update ${ref} ${hash}`).join('\n')+'\n',env);
      if(args.operation==='push' && args.refspecs.some(ref=>/^\+?HEAD:/.test(ref))){
        const head=(await gitCall(['rev-parse','--verify','HEAD'],cwd,lifetime)).stdout.trim();
        if(!/^[a-f0-9]{40,64}$/.test(head))throw new Error('Invalid HEAD');
        await writeFile(join(temporary,'HEAD'),head+'\n');
      }
      let result:{stdout:string;stderr:string};
      try { result=await gitCall([...clean,'-c','credential.helper=','-c','protocol.allow=never','-c','protocol.http.allow=always',
        '-c','http.followRedirects=false','-c','http.proxy=','-c','http.extraHeader=',args.operation,
        ...(args.operation==='fetch'?['--tags','--no-recurse-submodules']:['--no-verify']),'--',url,...args.refspecs],temporary,lifetime,undefined,env); }
      catch(error){ throw new Error(String(maskOutput((error as Error).message.replaceAll(url,p.http.origin+args.remotePath)))); }
      if(args.operation==='fetch'){
        const after=refMap((await gitCall([...clean,'for-each-ref','--format=%(refname) %(objectname)'],temporary,lifetime,undefined,env)).stdout);
        const changes=[...after].filter(([ref,hash])=>before.get(ref)!==hash);
        if(changes.some(([ref])=>!ref.startsWith('refs/remotes/')&&!ref.startsWith('refs/tags/')))throw new Error('Fetch changed an unexpected ref');
        if(changes.length) await gitCall(['update-ref','--stdin'],cwd,lifetime,'start\n'+changes.map(([ref,hash])=>`update ${ref} ${hash} ${before.get(ref)??'0'.repeat(format==='sha256'?64:40)}`).join('\n')+'\nprepare\ncommit\n');
      }
      return maskOutput({exitCode:0,stdout:result.stdout.replaceAll(url,p.http.origin+args.remotePath),stderr:result.stderr.replaceAll(url,p.http.origin+args.remotePath)});
    } finally {await rm(temporary,{recursive:true,force:true});}
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
