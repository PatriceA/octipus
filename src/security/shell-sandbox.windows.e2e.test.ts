/** Real Windows tests, required in Windows CI; never treat a missing helper as a skip. */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { prepareSandboxedLaunch } from '@/mcp/transports/stdio';
import { buildIsolatedChildEnv } from './child-env';
import { pluginRunnerState } from './shell-sandbox';
import { windowsSandboxBinary } from './windows-plugin-sandbox';

test.skipIf(process.platform !== 'win32')('AppContainer runs plugins with RO package, RW data, filtered egress and no host access', async () => {
  expect(windowsSandboxBinary(), 'build the helper with npm run build:sandbox:windows').toBeTruthy();
  expect(pluginRunnerState()).toMatchObject({ runner: 'appcontainer', problem: null });
  const base = mkdtempSync(join(tmpdir(), 'octipus-windows-e2e-'));
  const pkg = join(base, 'package'); const data = join(base, 'data');
  mkdirSync(pkg); mkdirSync(data);
  const homeSecret = join(homedir(), `octipus-denied-${Date.now()}.txt`);
  writeFileSync(homeSecret, 'must-not-read');
  writeFileSync(join(pkg, 'allowed.txt'), 'package-ok');
  writeFileSync(join(pkg, 'support.cjs'), "module.exports='module-ok';");
  const server = createServer((_req, res) => { res.writeHead(200); res.end('host-api-ok'); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('no host port');
  const script = `
    const fs=require('node:fs'), http=require('node:http'), net=require('node:net');
    const result={dependency:require('./support.cjs')};
    function probe(key, f) {try {result[key]={ok:true,value:f()};}catch(e){result[key]={ok:false,code:e.code,message:e.message};}}
    probe('readPackage',()=>fs.readFileSync('allowed.txt','utf8'));
    probe('writePackage',()=>fs.writeFileSync('planted.txt','bad'));
    probe('readHome',()=>fs.readFileSync(${JSON.stringify(homeSecret)},'utf8'));
    probe('writeData',()=>{fs.writeFileSync(${JSON.stringify(join(data, 'state.txt'))},'data-ok');return 'data-ok'});
    probe('writeTmp',()=>fs.writeFileSync(require('node:path').join(process.env.TEMP,'temp-ok'),'ok'));
    result.secretLeaked = process.env.MASTER_KEY !== undefined;
    const request=(url,path)=>new Promise(resolve=>{const r=http.get(url,{path},res=>{let body='';res.on('data',d=>body+=d);res.on('end',()=>resolve({status:res.statusCode,body}));});r.setTimeout(4000,()=>r.destroy(new Error('timeout')));r.on('error',e=>resolve({error:e.message}));});
    (async()=>{
      result.host=await request(process.env.HTTP_PROXY,'http://octipus-host.internal/api/plugin-host/probe');
      result.undeclared=await request(process.env.HTTP_PROXY,'http://undeclared.invalid/');
      result.proxyClose=[];
      for(let i=0;i<5;i++) result.proxyClose.push(await new Promise(resolve=>{
        const s=net.connect({path:process.env.OCTIPUS_EGRESS_PIPE});
        s.setTimeout(3000); let body='';
        s.on('connect',()=>s.write('GET http://octipus-host.internal/api/plugin-host/probe HTTP/1.0\\r\\nHost: octipus-host.internal\\r\\n\\r\\n'));
        s.on('data',d=>body+=d);
        s.on('end',()=>resolve(body.includes('host-api-ok')?'closed':'bad response'));
        s.on('timeout',()=>{s.destroy();resolve('timeout')});
        s.on('error',e=>resolve(e.code));
      }));
      result.direct=await new Promise(resolve=>{const s=net.connect(${address.port},'127.0.0.1');s.setTimeout(3000);s.on('connect',()=>{s.destroy();resolve('connected')});s.on('timeout',()=>{s.destroy();resolve('blocked')});s.on('error',()=>resolve('blocked'));});
      console.log(JSON.stringify(result));
    })().catch(e=>{console.error(e);process.exit(1)});
  `;
  writeFileSync(join(pkg, 'probe.cjs'), script);
  const launch = await prepareSandboxedLaunch(['node', 'probe.cjs'], buildIsolatedChildEnv(), {
    mode: 'required', root: pkg, readOnlyRoot: true, writable: [data], allowNetwork: false,
    egress: { label: 'windows-e2e', hosts: [], hostApi: { host: '127.0.0.1', port: address.port } },
  });
  try {
    expect(launch.networkEnforced).toBe(true);
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(launch.argv[0], launch.argv.slice(1), { cwd: pkg, env: launch.env, stdio: 'pipe', windowsHide: true });
      let stdout = ''; let stderr = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error(`sandbox timed out: ${stderr}`)); }, 25000);
      child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
      child.on('error', e => { clearTimeout(timer); reject(e); });
      child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
    expect(result.code, result.stderr).toBe(0);
    const probes = JSON.parse(result.stdout.trim());
    expect(probes, result.stderr).toMatchObject({ dependency: 'module-ok', readPackage: { ok: true, value: 'package-ok' }, writePackage: { ok: false },
      readHome: { ok: false }, writeData: { ok: true }, writeTmp: { ok: true }, secretLeaked: false,
      host: { status: 200, body: 'host-api-ok' }, undeclared: { status: 403 }, direct: 'blocked',
      proxyClose: ['closed', 'closed', 'closed', 'closed', 'closed'] });
    expect(readFileSync(join(data, 'state.txt'), 'utf8')).toBe('data-ok');
  } finally {
    launch.cleanup(); await launch.proxy?.close();
    await new Promise<void>(r => server.close(() => r()));
    rmSync(homeSecret, { force: true }); rmSync(base, { recursive: true, force: true });
  }
}, 60000);

test.skipIf(process.platform !== 'win32')('job kills descendants on forced termination; concurrent/restarted authorities keep data usable', async () => {
  const base = mkdtempSync(join(tmpdir(), 'octipus-windows-job-'));
  const pkg = join(base, 'package'); const data = join(base, 'data'); mkdirSync(pkg); mkdirSync(data);
  const launches: Awaited<ReturnType<typeof prepareSandboxedLaunch>>[] = [];
  const children: ReturnType<typeof spawn>[] = [];
  async function start(name: string, authority: string) {
    const path = join(data, `${name}.txt`);
    const code = `const {spawn}=require('node:child_process'),fs=require('node:fs');
      const pulse=()=>fs.writeFileSync(${JSON.stringify(path)},String(Date.now()));
      pulse();setInterval(pulse,50);
      const report=(extra)=>console.log(JSON.stringify({pid:process.pid,...extra}));
      try {
        const child=spawn(process.execPath,['-e',${JSON.stringify(`setInterval(()=>{},1000)`)}],{stdio:'inherit'});
        child.on('spawn',()=>report({grandchild:child.pid}));
        child.on('error',e=>report({grandchild:null,spawnDenied:e.code}));
      } catch(e) {report({grandchild:null,spawnDenied:e.code})}`;
    const launch = await prepareSandboxedLaunch([process.execPath, '-e', code], buildIsolatedChildEnv({ TEST_AUTHORITY: authority }), {
      mode: 'required', root: pkg, readOnlyRoot: true, writable: [data], allowNetwork: false,
    });
    launches.push(launch);
    const child = spawn(launch.argv[0], launch.argv.slice(1), { cwd: pkg, env: launch.env, stdio: 'pipe', windowsHide: true });
    children.push(child);
    const pids = await new Promise<{ pid: number; grandchild: number | null; spawnDenied?: string }>((resolve, reject) => {
      let output = ''; let errors = '';
      const timer = setTimeout(() => reject(new Error(`job readiness timeout: ${errors}`)), 10000);
      child.stderr!.on('data', d => { errors += d; });
      child.stdout!.on('data', d => { output += d; if (output.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(output.trim())); } });
      child.on('error', e => { clearTimeout(timer); reject(e); });
      child.on('exit', code => { clearTimeout(timer); reject(new Error(`helper exited ${code}: ${errors}`)); });
    });
    return { child, path, pids };
  }
  try {
    const [a, b] = await Promise.all([start('first', 'same'), start('second', 'same')]);
    await new Promise(r => setTimeout(r, 500));
    expect(readFileSync(a.path, 'utf8')).toMatch(/^\d+$/);
    expect(readFileSync(b.path, 'utf8')).toMatch(/^\d+$/);
    const stopped = new Promise<void>(r => a.child.once('close', () => r())); a.child.kill(); await stopped;
    await new Promise(r => setTimeout(r, 500));
    const first = readFileSync(a.path, 'utf8'); const second = readFileSync(b.path, 'utf8');
    await new Promise(r => setTimeout(r, 500));
    expect(readFileSync(a.path, 'utf8')).toBe(first);
    expect(readFileSync(b.path, 'utf8')).not.toBe(second);
    for (const pid of [a.pids.pid, a.pids.grandchild]) {
      if (pid !== null) expect(() => process.kill(pid, 0)).toThrow();
    }
    if (a.pids.grandchild === null) expect(a.pids.spawnDenied).toMatch(/EPERM|EACCES/);
    // Provisioning remains usable after abrupt stop, including a changed
    // authority whose SID must be different from still-running b's identity.
    const c = await start('third', 'changed');
    await new Promise(r => setTimeout(r, 250));
    expect(readFileSync(c.path, 'utf8')).toMatch(/^\d+$/);
  } finally {
    await Promise.all(children.map(child => new Promise<void>(r => {
      if (child.exitCode !== null || child.signalCode !== null) return r();
      child.once('close', () => r()); child.kill();
    })));
    for (const launch of launches) launch.cleanup();
    rmSync(base, { recursive: true, force: true });
  }
}, 60000);

test.skipIf(process.platform !== 'win32')('ESM plugin entry and relative imports load from a read-only package', async () => {
  const base = mkdtempSync(join(tmpdir(), 'octipus-windows-esm-'));
  const pkg = join(base, 'package'); const data = join(base, 'data'); mkdirSync(pkg); mkdirSync(data);
  writeFileSync(join(pkg, 'support.mjs'), "export const message='esm-ok';");
  writeFileSync(join(pkg, 'server.mjs'), "import {message} from './support.mjs'; console.log(message);");
  const launch = await prepareSandboxedLaunch(['node', 'server.mjs'], buildIsolatedChildEnv(), {
    mode: 'required', root: pkg, readOnlyRoot: true, writable: [data], allowNetwork: false,
  });
  try {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(launch.argv[0], launch.argv.slice(1), { cwd: pkg, env: launch.env, stdio: 'pipe', windowsHide: true });
      let stdout = ''; let stderr = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error(`ESM load timed out: ${stderr}`)); }, 15000);
      child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('esm-ok');
  } finally { launch.cleanup(); rmSync(base, { recursive: true, force: true }); }
}, 30000);
