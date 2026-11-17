import { mkdtemp, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import type { PluginCompanionDecl } from '@/shared/plugin-package';
import { parseManifest } from './manifest';
import { computePermissions } from './permissions';
import { companionFile, companionFilesProblems } from './companions';
import { packPackage } from './pack';
import { makeTar, paxHeader } from '@/test-helpers/tar';
import { declarationItems } from '@/shared/plugin-declarations';
import { diffPermissions } from '@/shared/plugin-permissions';
import { indexPermissionsSchema } from './index-v2';

const companion: PluginCompanionDecl = {"id":"host-collector","title":"Host telemetry collector","description":"Optional read-only service providing CPU, RAM and AMD GPU metrics. Engine metrics work without it.","optional":true,"runsOn":"The Linux machine hosting the engine; use the physical host for physical RAM readings","platforms":["linux"],"requirements":["Python 3.9 or newer","systemd 247 or newer","Readable Linux procfs and AMD DRM sysfs for GPU readings"],"dataAccess":["CPU and RAM counters from /proc","AMD GPU counters from /sys","Optional process RSS and cgroup memory counters"],"privileges":"Administrator installs the service and provisions its credential. Runtime uses an unprivileged dynamic user with read-only system access.","installation":"manual","bundle":"collector/llama-monitor-collector.tar.gz","guide":"collector/README.md"};
const manifest = { name:'example-monitor', version:'1.0.0', apiVersion:'1.1.0', title:'Monitor', description:'Example', server:{command:'node',args:['server.mjs']}, tools:{read:{effect:'read'}}, companions:[companion] };
describe('companion declarations and bundles', () => {
 test('schema, summary, listing and consent preserve explanation; adding or changing asks again', () => {
  const m=parseManifest(manifest), p=computePermissions(m);
  expect(indexPermissionsSchema.parse(p).companions).toEqual([companion]);
  const declaration=declarationItems(p).find(d=>d.kind==='companion')!;
  expect(declaration.guidance).toContain('does not install or start');
  expect(declaration.detail).toContain('dataAccess');
  expect(diffPermissions({...p,companions:undefined},p).changes).toContainEqual(expect.objectContaining({kind:'companions',change:'added',widens:true}));
  expect(diffPermissions(p,{...p,companions:[{...companion,optional:false}]}).widened).toBe(true);
  expect(computePermissions(parseManifest({...manifest,apiVersion:'1.0.0',companions:undefined}))).not.toHaveProperty('companions');
 });
 test('rejects old API, executable lifecycle fields, duplicate ids, bad paths and misleading text', () => {
  expect(()=>parseManifest({...manifest,apiVersion:'1.0.0'})).toThrow(/apiVersion/);
  for(const item of [{...companion,bundle:'../x.tar.gz'},{...companion,guide:'/etc/passwd.md'},{...companion,command:'sudo run'},{...companion,title:'bad\ntext'}]){
   expect(()=>parseManifest({...manifest,companions:[item]})).toThrow();
  }
  expect(()=>parseManifest({...manifest,companions:[companion,companion]})).toThrow(/unique/);
 });
 test('rejects global PAX traversal, other extension headers and noncanonical extraction semantics', async () => {
  const dir=await mkdtemp(join(tmpdir(),'companion-pax-'));
  await writeFile(join(dir,'guide.md'),'setup');
  const m=parseManifest({...manifest,companions:[{...companion,bundle:'bundle.tar.gz',guide:'guide.md'}]});
  const global={...paxHeader('path','../../outside.txt'),type:'g'};
  const variants=[
   makeTar([global,{name:'safe.txt',data:'payload'}]),
   makeTar([paxHeader('path','safe.txt'),{name:'short.txt',data:'payload'}]),
   makeTar([{name:'long-name',type:'L',data:'safe.txt'},{name:'short.txt',data:'payload'}]),
   makeTar([{name:'link',type:'2',linkname:'../../outside'}]),
   makeTar([{name:'./safe.txt',data:'payload'}]),
   makeTar([{name:'safe.txt',mode:0o4755,data:'payload'}]),
   Buffer.concat([makeTar([{name:'safe.txt',data:'payload'}]),Buffer.from('hidden trailing bytes')]),
  ];
  for(const tar of variants){
   await writeFile(join(dir,'bundle.tar.gz'),gzipSync(tar));
   expect((await companionFilesProblems(m,dir)).length).toBeGreaterThan(0);
  }
  await writeFile(join(dir,'bundle.tar.gz'),gzipSync(makeTar([{name:'safe/',type:'5'},{name:'safe/file.txt',data:'payload'}])));
  expect(await companionFilesProblems(m,dir)).toEqual([]);
 });
 test('valid bundle is downloadable; missing files, links, traversal and duplicate archive entries are refused', async () => {
  const dir=await mkdtemp(join(tmpdir(),'companion-'));
  await writeFile(join(dir,'octipus-plugin.json'),JSON.stringify({...manifest,companions:undefined,apiVersion:'1.0.0'}));
  await writeFile(join(dir,'server.mjs'),'// fixture');
  const packed=await packPackage(dir);
  const m=parseManifest({...manifest,companions:[{...companion,bundle:'bundle.tar.gz',guide:'guide.md'}]});
  await writeFile(join(dir,'bundle.tar.gz'),packed.tarball);await writeFile(join(dir,'guide.md'),'setup');
  expect(await companionFilesProblems(m,dir)).toEqual([]);
  expect(await companionFile(dir,'guide.md',65536)).toEqual(Buffer.from('setup'));
  await expect(companionFile(dir,'../outside',100)).rejects.toThrow(/Invalid/);
  await symlink(join(dir,'guide.md'),join(dir,'link.md'));
  await expect(companionFile(dir,'link.md',65536)).rejects.toThrow(/regular/);
  const raw=gunzipSync(packed.tarball);
  // Repeat the full archive before its end blocks: duplicate paths are refused.
  const end=raw.findIndex((_,i)=>i%512===0&&raw.subarray(i,i+512).every(b=>b===0));
  await writeFile(join(dir,'bundle.tar.gz'),gzipSync(Buffer.concat([raw.subarray(0,end),raw])));
  expect((await companionFilesProblems(m,dir)).join()).toMatch(/Duplicate/);
  await writeFile(join(dir,'bundle.tar.gz'),'not gzip');
  expect((await companionFilesProblems(m,dir)).length).toBe(1);
 });
});
