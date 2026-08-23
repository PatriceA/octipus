/**
 * Where the RAM actually went.
 *
 * `top`, `ps` and per-process RSS all miss the single biggest consumer on this
 * kind of box: a resident ollama model is held by the GPU driver as GTT
 * (system RAM lent to an integrated GPU), so llama-server reports well under a
 * gigabyte of RSS while tens of gigabytes are genuinely gone. Summing RSS
 * across processes is also wrong in the other direction — it double-counts
 * shared pages, which is how a browser can appear to use 29GB when it uses 22.
 *
 * This reports PSS per process (shared pages counted once), GTT/VRAM held by
 * the GPU, and what each is costing you, so "we have 96GB and it is always
 * full" becomes an answerable question.
 *
 * Linux only — it reads /proc and /sys. Run: `npx tsx scripts/mem-report.ts`
 */

import { readFile, readdir } from 'node:fs/promises';

const MB = 1024;
const gb = (kb: number) => (kb / 1024 / 1024).toFixed(1).padStart(6) + ' GB';

async function meminfo(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const line of (await readFile('/proc/meminfo', 'utf-8')).split('\n')) {
    const m = line.match(/^(\w+):\s+(\d+) kB/);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

/** PSS per process, descending. Skips what we cannot read (kernel threads). */
async function processPss(minKb: number): Promise<Array<{ pid: string; comm: string; kb: number }>> {
  const rows: Array<{ pid: string; comm: string; kb: number }> = [];
  for (const pid of await readdir('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const roll = await readFile(`/proc/${pid}/smaps_rollup`, 'utf-8');
      const m = roll.match(/^Pss:\s+(\d+) kB/m);
      if (!m) continue;
      const kb = Number(m[1]);
      if (kb < minKb) continue;
      const comm = (await readFile(`/proc/${pid}/comm`, 'utf-8')).trim();
      rows.push({ pid, comm, kb });
    } catch {
      // Process exited mid-scan, or not ours to read.
    }
  }
  return rows.sort((a, b) => b.kb - a.kb);
}

/** GPU memory, which on an integrated GPU is carved out of the same DIMMs. */
async function gpuMemory(): Promise<Array<{ card: string; vramUsed: number; vramTotal: number; gttUsed: number }>> {
  const out = [];
  for (const card of await readdir('/sys/class/drm').catch(() => [] as string[])) {
    if (!/^card\d+$/.test(card)) continue;
    const read = async (f: string) => {
      try {
        return Number((await readFile(`/sys/class/drm/${card}/device/mem_info_${f}`, 'utf-8')).trim()) / 1024;
      } catch {
        return NaN;
      }
    };
    const vramTotal = await read('vram_total');
    if (!Number.isFinite(vramTotal)) continue;
    out.push({ card, vramUsed: await read('vram_used'), vramTotal, gttUsed: await read('gtt_used') });
  }
  return out;
}

const info = await meminfo();
console.log('\n=== System ===');
console.log(`  total       ${gb(info.MemTotal)}`);
console.log(`  available   ${gb(info.MemAvailable)}   ← the only number that predicts whether a big load will fit`);
console.log(`  free        ${gb(info.MemFree)}`);
console.log(`  page cache  ${gb(info.Cached ?? 0)}   (reclaimable — counted inside "available")`);
console.log(`  swap        ${gb(info.SwapTotal)}${info.SwapTotal === 0 ? '   ← none: memory pressure has nowhere to go but OOM' : ''}`);

const gpus = await gpuMemory();
if (gpus.length) {
  console.log('\n=== GPU (integrated ⇒ this IS system memory) ===');
  for (const g of gpus) {
    console.log(`  ${g.card}  dedicated VRAM ${gb(g.vramUsed)} used of ${gb(g.vramTotal)} carved out`);
    console.log(`  ${' '.repeat(g.card.length)}  GTT (borrowed from system RAM) ${gb(g.gttUsed)}  ← invisible to ps/top`);
    if (g.vramTotal > 0 && g.vramUsed / g.vramTotal < 0.25 && g.gttUsed > g.vramTotal) {
      console.log(`  ${' '.repeat(g.card.length)}  NOTE: the carve-out is mostly idle while GTT does the work —`);
      console.log(`  ${' '.repeat(g.card.length)}        shrinking it in BIOS would return ~${gb(g.vramTotal - g.vramUsed)} to the system.`);
    }
  }
}

const procs = await processPss(200 * MB);
console.log('\n=== Processes by PSS (shared pages counted once, >200MB) ===');
for (const p of procs.slice(0, 15)) console.log(`  ${gb(p.kb)}  ${p.comm} (pid ${p.pid})`);

const procTotal = procs.reduce((s, p) => s + p.kb, 0);
const gttTotal = gpus.reduce((s, g) => s + (Number.isFinite(g.gttUsed) ? g.gttUsed : 0), 0);
console.log('\n=== Accounting ===');
console.log(`  processes (>200MB)  ${gb(procTotal)}`);
console.log(`  GPU GTT             ${gb(gttTotal)}`);
console.log(`  sum                 ${gb(procTotal + gttTotal)}  vs "used" ${gb(info.MemTotal - info.MemAvailable)}`);
console.log('  A large gap here is usually a resident model: check `curl -s localhost:11434/api/ps`.\n');
