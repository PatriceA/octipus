/**
 * Re-pin the local embedding engine (docs/RAG.md → Local embeddings): a
 * maintainer runs this, reviews the diff of manifest.json and commits it.
 * Nothing at install time ever follows `latest` or `main`.
 *
 *   npx tsx scripts/pin-local-engine.ts [--tag b12345]
 *   npx tsx scripts/pin-local-engine.ts --check     (weekly CI: every pinned URL still answers, nothing written)
 *
 * - engine: the release's asset SHA-256s (GitHub's `digest`) for each platform;
 * - models: each model's file size and SHA-256 at its pinned revision
 *   (Hugging Face's LFS metadata), checked against what is recorded.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { manifestProblems, type LocalEngineManifest } from '@/capabilities/local-engine/manifest';

const file = resolve(import.meta.dirname, '../src/capabilities/local-engine/manifest.json');
const manifest = JSON.parse(readFileSync(file, 'utf8')) as LocalEngineManifest & { $comment?: string };
const CHECK = process.argv.includes('--check');
const failures: string[] = [];
const tagIdx = process.argv.indexOf('--tag');
if (tagIdx > 0) manifest.engine.tag = process.argv[tagIdx + 1] ?? manifest.engine.tag;

const gh = await fetch(`https://api.github.com/repos/${manifest.engine.repo}/releases/tags/${manifest.engine.tag}`, {
  headers: { accept: 'application/vnd.github+json', 'user-agent': 'octipus-pin-local-engine', ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) },
});
if (!gh.ok) throw new Error(`GitHub release ${manifest.engine.tag}: HTTP ${gh.status}`);
const release = (await gh.json()) as { assets: Array<{ name: string; digest?: string | null }> };
const gpuAssets = Object.entries(manifest.engine.gpu?.vulkan ?? {}).map(([key, a]) => [`vulkan ${key}`, a] as const);
for (const [key, asset] of [...Object.entries(manifest.engine.assets), ...gpuAssets]) {
  if (!asset) continue;
  const hit = release.assets.find((a) => new RegExp(asset.pattern).test(a.name));
  if (!hit) { failures.push(`${key}: no asset matches ${asset.pattern}`); continue; }
  const digest = hit.digest?.startsWith('sha256:') ? hit.digest.slice(7) : null;
  if (CHECK) {
    if (asset.sha256 && digest && asset.sha256 !== digest) failures.push(`${key}: pinned SHA-256 differs from the release's`);
    process.stdout.write(`${key}: ${hit.name} ok\n`);
    continue;
  }
  asset.sha256 = digest;
  process.stdout.write(`${key}: ${hit.name} ${asset.sha256 ?? '(no digest; checked at install)'}\n`);
}

for (const model of manifest.models) {
  const res = await fetch(`https://huggingface.co/api/models/${model.repo}/tree/${model.revision}`);
  if (!res.ok) throw new Error(`${model.repo}@${model.revision}: HTTP ${res.status}`);
  const tree = (await res.json()) as Array<{ path: string; size: number; lfs?: { oid: string; size: number } }>;
  const entry = tree.find((e) => e.path === model.file);
  if (!entry?.lfs) { failures.push(`${model.id}: ${model.file} is not an LFS file at ${model.revision}`); continue; }
  if (CHECK) {
    const head = await fetch(`https://huggingface.co/${model.repo}/resolve/${model.revision}/${model.file}`, { method: 'HEAD', redirect: 'manual' });
    if (head.status >= 400) failures.push(`${model.id}: download answers HTTP ${head.status}`);
    if (model.sha256 !== entry.lfs.oid || model.size !== entry.lfs.size) failures.push(`${model.id}: pinned SHA-256/size differ from the file at ${model.revision}`);
    process.stdout.write(`${model.id}: ok\n`);
    continue;
  }
  if (model.sha256 !== entry.lfs.oid || model.size !== entry.lfs.size) {
    process.stdout.write(`${model.id}: updated (${model.sha256.slice(0, 12)} → ${entry.lfs.oid.slice(0, 12)})\n`);
    model.sha256 = entry.lfs.oid;
    model.size = entry.lfs.size;
  } else process.stdout.write(`${model.id}: unchanged\n`);
}

if (failures.length) {
  process.stderr.write(`Local engine manifest:\n  ${failures.join('\n  ')}\n`);
  process.exit(1);
}
if (CHECK) process.exit(0);

const problems = manifestProblems(manifest);
if (problems.length) throw new Error(`The manifest has problems:\n  ${problems.join('\n  ')}`);
writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`Wrote ${file}. Review the diff, run the local-engine tests, commit.\n`);
