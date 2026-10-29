#!/usr/bin/env node
/**
 * Is a build output older than the sources it was built from?
 *
 *   node scripts/needs-build.mjs [backend|mcp-server|web]   (default: backend)
 *
 * `octi start` runs `node dist/index.js`, a build artifact that nothing
 * rebuilt, so after a `git pull` the backend went on serving the previous
 * checkout: healthy, answering every route, with the pulled change simply
 * absent. The CLIs call this before starting the backend, and `octi start`
 * asks it about the MCP server and the web bundle too, which it used to
 * rebuild on every start whether anything had changed or not.
 *
 * Exit 0 — the output is current, nothing to do.
 * Exit 1 — the output is missing or stale, rebuild.
 *
 * One implementation for both CLIs. The obvious shell equivalents are not
 * equivalent: `find -newer` is POSIX-only, and the PowerShell version of the
 * same question took over two minutes on Windows.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Content identity, independent of restored/copied file timestamps. */
export function backendInputFingerprint(projectDir) {
  const hash = createHash('sha256');
  const add = (path, label) => hash.update(JSON.stringify([label, createHash('sha256').update(readFileSync(path)).digest('hex')]));
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name,'en'))) {
      if (entry.name.endsWith('.tsbuildinfo')) continue;
      const path = join(dir, entry.name), label = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(path, label);
      else add(path, label);
    }
  };
  walk(join(projectDir, 'src'), 'src');
  for (const file of ['package.json','package-lock.json','tsconfig.json','scripts/build.ts','scripts/needs-build.mjs']) {
    if (existsSync(join(projectDir,file))) add(join(projectDir,file),file);
    else hash.update(JSON.stringify([file,null]));
  }
  return hash.digest('hex');
}

export function writeBackendBuildInfo(projectDir, inputsFingerprint, runtimeFiles = ['index.js']) {
  if (!runtimeFiles.includes('index.js')) throw new Error('Runtime outputs must include index.js');
  if (backendInputFingerprint(projectDir) !== inputsFingerprint) throw new Error('Backend sources changed during the build; run the build again');
  const git = spawnSync('git',['rev-parse','HEAD'],{cwd:projectDir,encoding:'utf8',timeout:5000});
  const status = spawnSync('git',['status','--porcelain'],{cwd:projectDir,encoding:'utf8',timeout:5000});
  const outputs = Object.fromEntries(runtimeFiles.map(name => {
    if (name !== 'index.js' && !/^[a-zA-Z0-9_.-]+\.py$/.test(name)) throw new Error('Invalid runtime output name');
    return [name,createHash('sha256').update(readFileSync(join(projectDir,'dist',name))).digest('hex')];
  }));
  const info = { version:1, inputsFingerprint, outputs,
    bundleSha256:outputs['index.js'],
    commit:git.status===0?git.stdout.trim():null, dirty:status.status===0?status.stdout.trim().length>0:null };
  writeFileSync(join(projectDir,'dist/build-info.json'),JSON.stringify(info,null,2));
}

/**
 * Per target: the file its build writes, the directories it reads, the single
 * files it reads, and directory names inside those that are not inputs.
 */
const TARGETS = {
  backend: { output: 'dist/index.js', dirs: ['src'], files: ['package.json'], skip: [] },
  'mcp-server': {
    output: 'mcp-server/dist/index.js',
    dirs: ['mcp-server/src'],
    files: ['mcp-server/package.json', 'mcp-server/tsconfig.json'],
    skip: [],
  },
  // The web app imports from the backend's src/ (shared types, protocol,
  // task helpers), so any of it counts. index.html is the last file Vite
  // writes. OCTIPUS_WEB_DIST_DIR is the same override vite.config.ts and
  // serve.mjs read.
  web: {
    output: join('web', process.env.OCTIPUS_WEB_DIST_DIR || 'dist', 'index.html'),
    dirs: ['web', 'src'],
    files: [],
    skip: ['node_modules', 'dist', 'out', 'src-tauri', 'test-results', 'playwright-report'],
  },
};

/** Is anything under `dir` newer than `limit`? Stops at the first that is. */
function anyNewerThan(dir, limit, skip) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // By name, whatever the entry is: node_modules may be a symlink.
    if (skip.includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (anyNewerThan(path, limit, skip)) return true;
      continue;
    }
    // Written by `tsc` type checks, not read by the build.
    if (entry.name.endsWith('.tsbuildinfo')) continue;
    if (statSync(path).mtimeMs > limit) return true;
  }
  return false;
}

function stale(target) {
  let built;
  try {
    built = statSync(resolve(root, target.output)).mtimeMs;
  } catch {
    return true; // never built
  }
  if (target === TARGETS.backend && existsSync(join(root,'src'))) {
    // Legacy artifacts rebuild once. A receipt binds source contents to the
    // actual bundle: neither git HEAD nor an output's mtime proves freshness.
    try {
      const info=JSON.parse(readFileSync(join(root,'dist/build-info.json'),'utf8'));
      return info.version!==1 || info.inputsFingerprint!==backendInputFingerprint(root)
        || typeof info.bundleSha256!=='string' || !/^[a-f0-9]{64}$/.test(info.bundleSha256)
        || !info.outputs || typeof info.outputs!=='object' || Array.isArray(info.outputs) || info.outputs['index.js']!==info.bundleSha256
        || Object.entries(info.outputs).some(([name,hash]) => (name !== 'index.js' && !/^[a-zA-Z0-9_.-]+\.py$/.test(name))
          || typeof hash!=='string' || !/^[a-f0-9]{64}$/.test(hash) || hash!==createHash('sha256').update(readFileSync(join(root,'dist',name))).digest('hex'));
    } catch { return true; }
  }
  for (const input of target.files) {
    try {
      if (statSync(join(root, input)).mtimeMs > built) return true;
    } catch { /* not present — not a build input then */ }
  }
  for (const dir of target.dirs) {
    try {
      if (anyNewerThan(join(root, dir), built, target.skip)) return true;
    } catch (err) {
      // No sources (a packaged install): the output is all there is. Anything
      // else, a dangling link among them say, rebuilds rather than guesses.
      if (err?.code === 'ENOENT' && err.path === join(root, dir)) continue;
      process.stderr.write(`needs-build: ${err?.message ?? err} — rebuilding\n`);
      return true;
    }
  }
  return false;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const name = process.argv[2] ?? 'backend';
  const target = TARGETS[name];
  if (!target) {
    process.stderr.write(`needs-build: unknown target "${name}" (expected ${Object.keys(TARGETS).join(', ')})\n`);
    process.exit(2);
  }
  process.exitCode = stale(target) ? 1 : 0;
}
