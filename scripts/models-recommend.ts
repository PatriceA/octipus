/**
 * `octi models recommend [--install <id>] [--topic a,b]`
 *
 * Standalone hwfit surface. `recommend` runs the hardware probe + live sizing +
 * scoring entirely locally (no backend, no auth, works offline) and prints a
 * ranked table. `--install <id>` pulls the catalog model into Ollama, registers
 * it, and binds it to topics — reusing the same orchestration the API route uses.
 */
import { getCatalogEntry, MODEL_CATALOG, resolveSizes, type ScoredModel, scoreCatalog } from '../src/capabilities/hwfit';
import { type InstallJob, runInstall } from '../src/capabilities/hwfit/install';
import { closeDb, initializeDb } from '../src/db/postgres';
import { closeStorage, initializeStorage } from '../src/db/storage';
import { getModelRegistry } from '../src/models/model-registry';
import { OllamaProvider } from '../src/models/providers/ollama-provider';
import { initializeVault } from '../src/security/vault';
import { probeHardware } from '../src/setup/probes';

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const fmtGB = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`);

async function recommend(): Promise<void> {
  process.stdout.write('Scanning hardware…\n');
  const hardware = await probeHardware();
  const sized = await resolveSizes();
  const scored = scoreCatalog(hardware, sized);

  const gpu = hardware.gpus.length > 0
    ? `${hardware.gpus.map((g) => g.name).join(', ')} · ${fmtGB(hardware.totalVramMB)} VRAM`
    : 'no GPU (CPU-only)';
  process.stdout.write(
    `\nHardware: ${gpu} · ${hardware.cpu.cores} cores · ${fmtGB(hardware.ramMB)} RAM ` +
      `${DIM}(via ${hardware.source.join(', ')})${RESET}\n\n`,
  );

  const shown = scored.filter((s) => s.recommended || s.fits);
  for (const s of shown) printRow(s);
  const hidden = scored.length - shown.length;
  if (hidden > 0) process.stdout.write(`${DIM}  …and ${hidden} more that don't fit this hardware.${RESET}\n`);

  process.stdout.write(`\nInstall one with:  ${DIM}octi models recommend --install <id>${RESET}\n`);
}

function printRow(s: ScoredModel): void {
  const mark = s.recommended ? `${GREEN}★${RESET}` : s.fits ? `${GREEN}✓${RESET}` : `${YELLOW}·${RESET}`;
  const size = `${fmtGB(s.entry.vramMB)}${s.entry.sizeSource === 'live' ? '' : ' (est.)'}`;
  const topics = s.entry.topics.join(',');
  process.stdout.write(`  ${mark}  ${s.entry.id.padEnd(40)} ${size.padEnd(12)} ${DIM}${topics}${RESET}\n`);
  if (s.note) process.stdout.write(`     ${YELLOW}${s.note}${RESET}\n`);
}

async function install(id: string, topicFilter: string[]): Promise<number> {
  const entry = getCatalogEntry(id);
  if (!entry) {
    process.stderr.write(`Unknown model "${id}". Known ids:\n`);
    for (const m of MODEL_CATALOG) process.stderr.write(`  ${m.id}\n`);
    return 2;
  }

  // Local install needs the DB to register + bind.
  const mode = (process.env.STORAGE_MODE || 'external') as 'embedded' | 'external';
  if (mode === 'embedded') initializeStorage({ mode: 'embedded' });
  await initializeDb();
  await initializeVault();

  try {
    const registry = getModelRegistry();
    if (await registry.getModel(entry.id)) {
      process.stdout.write(`${GREEN}✓${RESET} "${entry.id}" is already registered.\n`);
      return 0;
    }

    const bindTopics = topicFilter.length ? entry.topics.filter((t) => topicFilter.includes(t)) : entry.topics;
    if (bindTopics.length === 0) {
      process.stderr.write(`None of [${topicFilter.join(', ')}] are served by "${entry.id}" (serves: ${entry.topics.join(', ')}).\n`);
      return 2;
    }

    const provider = new OllamaProvider();
    const job: InstallJob = {
      id: 'cli', modelId: entry.id, bindTopics, status: 'pulling', percent: 0, statusText: 'starting', startedAt: Date.now(),
    };

    process.stdout.write(`Pulling ${entry.id}…\n`);
    let lastPct = -1;
    await runInstall(job, entry, {
      pull: (mid, onProgress) =>
        provider.pull(mid, (p) => {
          onProgress(p);
          if (typeof p.percent === 'number' && p.percent !== lastPct) {
            lastPct = p.percent;
            process.stdout.write(`\r  ${p.status.padEnd(28)} ${p.percent}%   `);
          }
        }),
      register: async (e) => {
        await registry.registerModel(e);
      },
      isFirstModel: async () => (await registry.getDefaultModel()) === null,
    });
    process.stdout.write('\n');

    if (job.status === 'error') {
      process.stderr.write(`${YELLOW}Install failed:${RESET} ${job.error}\n`);
      return 1;
    }
    process.stdout.write(`${GREEN}✓${RESET} Installed ${job.modelName} · bound to ${bindTopics.join(', ')}\n`);
    return 0;
  } finally {
    await closeDb();
    closeStorage();
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2).filter((a) => a !== 'recommend');
  const installIdx = args.indexOf('--install');
  const topicIdx = args.indexOf('--topic');
  const topicFilter = topicIdx !== -1 ? (args[topicIdx + 1] ?? '').split(',').map((t) => t.trim()).filter(Boolean) : [];

  if (installIdx !== -1) {
    const id = args[installIdx + 1];
    if (!id) {
      process.stderr.write('octi models recommend --install: missing model id.\n');
      return 2;
    }
    return install(id, topicFilter);
  }

  await recommend();
  return 0;
}

process.exit(await main());
