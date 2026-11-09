import { safeRegExp } from '@/utils/sanitize';
import { posix } from 'node:path';
import type { AgentContext } from '@/core/types';
import { SessionFileError } from '@/core/session-files';
import { ToolNotExecutedError, markToolNotExecuted } from '@/core/tool-execution-error';
import { executionEnvironmentFor } from '@/security/execution-environments';
import { quoteRuntimeArg, SshShellOperations } from '@/security/environment-runtime';
import { withFileMutationQueue } from '@/utils/file-mutation-queue';

/** Executed by Node on the selected remote account. JSON is data, never shell syntax. */
export const REMOTE_FILESYSTEM_PROGRAM = String.raw`
const f=require('node:fs'),p=require('node:path'),c=require('node:crypto');let lock,mutated=false;
try {
const q=JSON.parse(Buffer.from(f.readFileSync(0,'utf8'),'base64').toString('utf8'));
const inside=(r,x)=>{const d=p.relative(r,x);return d===''||(!p.isAbsolute(d)&&d!=='..'&&!d.startsWith('../'))};
const roots=q.roots.map(r=>f.realpathSync(r));
function target(raw){
 if(typeof raw!=='string'||raw.includes('\0'))throw Error('Choose a valid path');
 const x=p.resolve(q.cwd,raw);if(!q.roots.map(r=>p.resolve(r)).some(r=>inside(r,x))&&!roots.some(r=>inside(r,x)))throw Error('Path is outside approved remote folders');
 const exists=x=>{try{f.lstatSync(x);return true}catch(e){if(e.code==='ENOENT')return false;throw e}};
 let a=x;while(!exists(a)){const n=p.dirname(a);if(n===a)throw Error('No existing parent');a=n}
 const real=p.resolve(f.realpathSync(a),p.relative(a,x));if(!roots.some(r=>inside(r,real)))throw Error('Symlink leaves approved remote folders');return real;
}
const a=q.args,op=q.operation;
const path=target(a.path??a.source??'.');let result;
function text(){const s=f.statSync(path);if(s.size>1048576)throw Error('File is too large; maximum is 1 MiB');return f.readFileSync(path,a.encoding??'utf8')}
function listing(dir,recursive,hidden,depth=0,out=[]){
 if(depth>32||out.length>=1000)return out;
 for(const e of f.readdirSync(dir,{withFileTypes:true})){
  if(!hidden&&e.name.startsWith('.'))continue;
  const full=p.join(dir,e.name);if(e.isSymbolicLink())continue;
  out.push({name:e.name,path:full,type:e.isDirectory()?'directory':'file'});
  if(out.length>=1000)break;if(recursive&&e.isDirectory())listing(full,true,hidden,depth+1,out);
 }return out;
}
if(op==='changes'||op==='change_diff'||op==='git_head'){
 const cp=require('node:child_process'),root=f.realpathSync(q.cwd);
 const git=(args,optional=false)=>{try{return cp.execFileSync('git',args,{cwd:root,encoding:'utf8',timeout:10000,maxBuffer:1048576,stdio:['ignore','pipe','pipe']})}catch(e){if(optional&&typeof e.status==='number')return null;throw e}};
 const top=git(['rev-parse','--show-toplevel'],true),isRepo=top&&f.realpathSync(top.trim())===root;
 if(op==='git_head'){const head=isRepo?git(['rev-parse','--short','HEAD'],true):null;result=head?head.trim()+(git(['status','--porcelain','--untracked-files=no']).trim()?' plus uncommitted changes':''):null}
 else if(op==='changes'){
 if(!isRepo)result={isGitRepo:false,changes:[]};else{
 const changes=git(['status','--porcelain','-z','--no-renames']).split('\0').filter(Boolean).slice(0,500).map(e=>({path:e.slice(3),status:e.startsWith('??')?'untracked':e.slice(0,2).includes('R')?'renamed':e.slice(0,2).includes('D')?'deleted':e.slice(0,2).includes('A')?'added':'modified'}));
 const branch=git(['rev-parse','--abbrev-ref','HEAD'],true)?.trim();result={isGitRepo:true,changes,...(branch&&branch!=='HEAD'?{branch}:{})};}
 }else{
 if(!inside(root,path))throw Error('Diff is outside this project');const rel=p.relative(root,path);let modified='',original='',truncated=false;
 const onDisk=f.existsSync(path);if(onDisk){const fd=f.openSync(path,'r');try{const size=f.fstatSync(fd).size,b=Buffer.alloc(Math.min(131072,size));f.readSync(fd,b,0,b.length,0);modified=b.toString('utf8');truncated=size>b.length}finally{f.closeSync(fd)}}
 const inHead=isRepo&&git(['cat-file','-e','HEAD:'+rel],true)!==null;
 if(inHead){const show=git(['cat-file','--filters','HEAD:'+rel],true);if(show===null)truncated=true;else{const b=Buffer.from(show);original=b.subarray(0,131072).toString('utf8');if(b.length>131072)truncated=true}}
 result={path:rel,status:!inHead&&onDisk?'added':inHead&&!onDisk?'deleted':'modified',original,modified,truncated};
 }
}else if(op==='snapshot'){
 const files=[],cfg=a.config,pruned=new Set(cfg.pruned),egg=new Set(cfg.egg),max=cfg.maxFiles;let truncated=false;
 const harness=r=>r===cfg.spill||r.startsWith(cfg.spill+'/');
 function walk(dir){if(truncated)return;let entries;try{entries=f.readdirSync(dir,{withFileTypes:true})}catch(e){if(e.code!=='ENOENT')truncated=true;return}
 entries.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
 for(const e of entries){if(truncated)return;const full=p.join(dir,e.name),rel=p.relative(path,full);
 if(e.isDirectory()){if(!pruned.has(e.name)&&!harness(rel))walk(full);continue}
 if(!e.isFile()||cfg.suffixes.some(s=>e.name.endsWith(s)))continue;
 const parts=rel.split('/');if(parts.length>=2&&parts[parts.length-2].endsWith('.egg-info')&&egg.has(parts[parts.length-1]))continue;
 if(files.length>=max){truncated=true;return}try{const s=f.statSync(full);files.push([rel,s.mtimeMs+':'+s.size])}catch(e){if(e.code!=='ENOENT')truncated=true}
 }}walk(path);result={files,truncated};
}else if(op==='read_session_file'){
 const stat=f.statSync(path);if(stat.isDirectory())result={type:'directory',path,entries:listing(path,false,true).map(e=>({name:e.name,path:e.path,isDirectory:e.type==='directory'}))};
 else if(stat.size>524288)result={type:'too-large',path,size:stat.size};
 else {const b=f.readFileSync(path),version=c.createHash('sha256').update(b).update(String(stat.mtimeMs)).digest('hex');
 const mime={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp'}[p.extname(path).toLowerCase()];
 const meta={path,version,size:b.length,modifiedAt:stat.mtime.toISOString()};
 result=mime?{...meta,type:'image',mimeType:mime,dataUrl:'data:'+mime+';base64,'+b.toString('base64')}:b.includes(0)?{...meta,type:'binary'}:{...meta,type:'text',content:b.toString('utf8')};}
}else if(op==='write_session_file'){
 const lockPath=p.join(roots[0],'.octipus-file-lock-'+c.createHash('sha256').update(path).digest('hex'));
 try{f.mkdirSync(lockPath);lock=lockPath}catch(e){if(e.code==='EEXIST')throw Object.assign(Error('File is being edited or a previous write was interrupted. Inspect the lock before retrying.'),{code:'CONFLICT',status:409});throw e}
 const before=f.existsSync(path)?f.readFileSync(path):null,stat=before?f.statSync(path):null;
 const version=before?c.createHash('sha256').update(before).update(String(stat.mtimeMs)).digest('hex'):null;
 if(a.baseVersion&&a.baseVersion!==version)throw Object.assign(Error('File changed since it was opened. Reload before saving.'),{code:'CONFLICT',status:409});
 if(typeof a.content!=='string'||Buffer.byteLength(a.content)>524288)throw Error('Choose text up to 512 KiB');
 mutated=true;f.mkdirSync(p.dirname(path),{recursive:true});f.writeFileSync(path,a.content,'utf8');const after=f.statSync(path);
 result={path,version:c.createHash('sha256').update(a.content).update(String(after.mtimeMs)).digest('hex'),size:after.size,modifiedAt:after.mtime.toISOString()};
}else if(op==='read_file'){const content=text();result={path,content,size:content.length}}
else if(op==='write_file'||op==='append_file'){
 if(typeof a.content!=='string')throw Error('content must be a string');
 if(Buffer.byteLength(a.content)>1048576)throw Error('Content is too large');
 mutated=true;if(a.createDirs!==false)f.mkdirSync(p.dirname(path),{recursive:true});
 if(op==='append_file')f.appendFileSync(path,a.content,'utf8');else f.writeFileSync(path,a.content,'utf8');
 result={success:true,path,bytesWritten:Buffer.byteLength(a.content)};
}else if(op==='edit_file'){
 const before=text();if(typeof a.old_string!=='string'||!a.old_string||typeof a.new_string!=='string'||a.old_string===a.new_string)throw Error('Choose a non-empty old_string and a different new_string');
 const count=before.split(a.old_string).length-1;if(!count||(!a.replace_all&&count!==1))throw Error('old_string must match exactly once, or use replace_all');
 const content=a.replace_all?before.split(a.old_string).join(a.new_string):before.replace(a.old_string,()=>a.new_string);
 mutated=true;f.writeFileSync(path,content,'utf8');result={success:true,path,replacements:a.replace_all?count:1};
}else if(op==='list_directory')result={path,entries:listing(path,a.recursive===true,a.includeHidden===true)};
else if(op==='file_info'){const s=f.statSync(path);result={path,name:p.basename(path),isFile:s.isFile(),isDirectory:s.isDirectory(),size:s.size,created:s.birthtime.toISOString(),modified:s.mtime.toISOString(),permissions:(s.mode&511).toString(8)}}
else if(op==='create_directory'){mutated=true;f.mkdirSync(path,{recursive:a.recursive!==false});result={success:true,path}}
else if(op==='delete_file'){if(roots.includes(f.realpathSync(path)))throw Error('Cannot delete an environment root');mutated=true;f.rmSync(path,{recursive:a.recursive===true});result={success:true,path}}
else if(op==='copy_file'||op==='move_file'){const dest=target(a.destination);mutated=true;f.mkdirSync(p.dirname(dest),{recursive:true});if(op==='copy_file')f.copyFileSync(path,dest);else f.renameSync(path,dest);result={success:true,source:path,destination:dest}}
else if(op==='search_files'){
 if(typeof a.pattern!=='string'||a.pattern.length>200)throw Error('Choose a short filename pattern');
 const pattern=new RegExp(a._validatedPattern),results=[];let scanned=0,truncated=false;
 const limit=Math.max(1,Math.min(1000,Number(a.maxResults)||100));
 function search(dir,depth=0){if(depth>32){truncated=true;return}for(const e of f.readdirSync(dir,{withFileTypes:true})){
 if(results.length>=limit){truncated=true;return}if(++scanned>100000){truncated=true;return}if(e.isSymbolicLink())continue;
 const full=p.join(dir,e.name);pattern.lastIndex=0;if(pattern.test(e.name))results.push(p.relative(f.realpathSync(q.cwd),full));if(e.isDirectory())search(full,depth+1);
 }}search(path);result={pattern:a.pattern,results,truncated};
}else throw Error('Unsupported filesystem operation');
let encoded=JSON.stringify(result);if(op==='snapshot'&&Buffer.byteLength(encoded)>800000)encoded=JSON.stringify({files:[],truncated:true});if(Buffer.byteLength(encoded)>900000)throw Error('Response is too large; read a smaller file or directory');process.stdout.write(encoded);
} catch(error) { process.stdout.write(JSON.stringify({__error:true,notExecuted:!mutated,message:error.message,code:error.code??'REMOTE_FILESYSTEM',status:error.status??(error.code==='ENOENT'?404:error.code==='EACCES'?403:400)})); process.exitCode=1; } finally { if(lock) f.rmdirSync(lock); }
`;

export async function remoteFilesystemOperation(operation: string, args: Record<string, unknown>, context: AgentContext): Promise<unknown> {
  const environment = executionEnvironmentFor(context);
  if (environment?.backend !== 'ssh') throw new ToolNotExecutedError('filesystem', 'No remote environment selected');
  const cwd = typeof context.metadata.projectPath === 'string' ? context.metadata.projectPath : environment.roots[0];
  if (operation === 'search_files') {
    const raw = String(args.pattern ?? '');
    const isGlob = /[*?]/.test(raw) && !/[()[\]^$|+\\]|\.[*?]/.test(raw);
    const pattern = safeRegExp(isGlob ? '^' + raw.replace(/^.*\//, '').replace(/[.{}\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$' : raw);
    if (!pattern) return { pattern: args.pattern, results: [], error: 'Invalid or too complex regex pattern' };
    args = { ...args, _validatedPattern: pattern.source };
  }
  const payload = Buffer.from(JSON.stringify({ operation, args, roots: environment.roots, cwd })).toString('base64');
  if (payload.length > 1_500_000) throw new ToolNotExecutedError('filesystem', 'Filesystem request is too large');
  return withFileMutationQueue(`ssh:${environment.id}:${posix.resolve(cwd, String(args.path ?? args.source ?? '.'))}`, async () => {
    const result = await new SshShellOperations(environment).exec(`node -e ${quoteRuntimeArg(REMOTE_FILESYSTEM_PROGRAM)}`, cwd, { timeout: 30000, input: payload });
    if (result.killed) throw new Error('Remote filesystem operation was interrupted; inspect its outcome before retrying a write');
    try {
      const parsed = JSON.parse(result.stdout);
      if (parsed.__error) {
        const error = new SessionFileError(parsed.status, parsed.code, parsed.message);
        throw parsed.notExecuted === true ? markToolNotExecuted('filesystem', error) : error;
      }
      if (result.exitCode !== 0) throw new Error('Remote filesystem process failed');
      return parsed;
    }
    catch (error) { if (error instanceof SessionFileError) throw error; throw new Error('Remote filesystem returned an invalid response', { cause: error }); }
  });
}
