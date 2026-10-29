import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { backendInputFingerprint, writeBackendBuildInfo } from './needs-build.mjs';
// @ts-expect-error — plain Node supervisor script
import { readBuildIdentity } from './supervisor.mjs';

const dirs:string[]=[];
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'octi-build-identity-'));dirs.push(root);
 for(const dir of ['scripts','src','dist'])mkdirSync(join(root,dir));
 copyFileSync('scripts/needs-build.mjs',join(root,'scripts/needs-build.mjs'));
 writeFileSync(join(root,'src/index.ts'),'export const version=1;');
 writeFileSync(join(root,'dist/index.js'),'console.log("built version1");');
 const run=()=>spawnSync(process.execPath,[join(root,'scripts/needs-build.mjs'),'backend'],{encoding:'utf8'}).status;
 const stamp=()=>writeBackendBuildInfo(root,backendInputFingerprint(root));
 return{root,run,stamp};
}
test('legacy source checkouts rebuild once, then matching contents are current',()=>{
 const f=fixture();expect(f.run()).toBe(1);f.stamp();expect(f.run()).toBe(0);
});
test('a copied old bundle with a newer timestamp is stale',()=>{
 const f=fixture();f.stamp();
 writeFileSync(join(f.root,'dist/index.js'),'console.log("restored old version");');
 utimesSync(join(f.root,'dist/index.js'),new Date('2099-01-01'),new Date('2099-01-01'));
 expect(f.run()).toBe(1);
});
test('source edits with preserved timestamps are stale; touching unchanged content is current',()=>{
 const f=fixture();f.stamp();
 const input=join(f.root,'src/index.ts');
 utimesSync(input,new Date('2099-01-01'),new Date('2099-01-01'));expect(f.run()).toBe(0);
 writeFileSync(input,'export const version=2;');utimesSync(input,new Date('2000-01-01'),new Date('2000-01-01'));
 expect(f.run()).toBe(1);
});
test('new and deleted source files invalidate a build',()=>{
 const f=fixture();f.stamp();const extra=join(f.root,'src/new.ts');writeFileSync(extra,'export const a=1;');
 expect(f.run()).toBe(1);f.stamp();rmSync(extra);expect(f.run()).toBe(1);
});
test('a build cannot claim inputs that changed while it ran',()=>{
 const f=fixture();const before=backendInputFingerprint(f.root);writeFileSync(join(f.root,'src/index.ts'),'changed');
 expect(()=>writeBackendBuildInfo(f.root,before)).toThrow(/changed during the build/);
});
test('malformed or incomplete runtime output receipts cannot mark a bundle current',()=>{
 const f=fixture();f.stamp();const receipt=join(f.root,'dist/build-info.json'),info=JSON.parse(readFileSync(receipt,'utf8'));
 for(const malformed of [{...info,outputs:{},bundleSha256:undefined},{...info,outputs:{...info.outputs,'missing.py':null}},{...info,outputs:[]}]){
  writeFileSync(receipt,JSON.stringify(malformed));expect(f.run()).toBe(1);
  expect(readBuildIdentity(join(f.root,'dist/index.js')).commit).toBeNull();
 }
 expect(()=>writeBackendBuildInfo(f.root,backendInputFingerprint(f.root),[])).toThrow(/include index.js/);
});
test.each(['restore','delete'])('runtime Python worker %s invalidates freshness and artifact identity',operation=>{
 const f=fixture();const worker=join(f.root,'dist/local_worker.py');writeFileSync(worker,'print("current")');
 writeBackendBuildInfo(f.root,backendInputFingerprint(f.root),['index.js','local_worker.py']);
 const receipt=join(f.root,'dist/build-info.json'),info=JSON.parse(readFileSync(receipt,'utf8'));
 writeFileSync(receipt,JSON.stringify({...info,commit:'a'.repeat(40),dirty:false}));
 expect(f.run()).toBe(0);expect(readBuildIdentity(join(f.root,'dist/index.js')).commit).toBe('a'.repeat(40));
 if(operation==='restore')writeFileSync(worker,'print("old worker")');else rmSync(worker);
 expect(f.run()).toBe(1);expect(readBuildIdentity(join(f.root,'dist/index.js')).commit).toBeNull();
});
test('supervisor reports receipt identity only when its bundle hash matches',()=>{
 const f=fixture();const entry=join(f.root,'dist/index.js');
 expect(readBuildIdentity(entry).commit).toBeNull();f.stamp();
 const path=join(f.root,'dist/build-info.json'),info=JSON.parse(readFileSync(path,'utf8'));
 const commit='a'.repeat(40);writeFileSync(path,JSON.stringify({...info,commit,dirty:true}));
 expect(readBuildIdentity(entry)).toMatchObject({commit,dirty:true,sha256:info.bundleSha256});
 writeFileSync(entry,'different bundle');expect(readBuildIdentity(entry).commit).toBeNull();
});
