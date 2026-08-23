/**
 * `octi` — TypeScript dispatcher.
 *
 * Bundled into `dist/octi` by `scripts/build-cli.ts`. The
 * resulting executable is what the install script drops onto PATH,
 * retiring the PATH-mutation that `scripts/setup.ts` used to do.
 *
 * Commands handled natively (no shell needed):
 *   - doctor   — environment health checks
 *   - init     — interactive setup wizard
 *   - persona  — print / configure the orchestrator persona
 *   - help     — banner + usage
 *   - version  — semver + Bun version
 *
 * Commands delegated to scripts:
 *   - tui      — `npm run tui`
 *   - edit     — `npm run tui:edit`
 *
 * Commands delegated to the bash dispatcher (`bin/octi`) when present:
 *   - start, stop, restart, status, logs, open
 * These manage PIDs, log files, port-kills, and other shell-heavy
 * tasks — porting them in full lives behind a follow-up. The
 * compiled binary still works for them as long as the user's clone
 * ships the bash script alongside (the standard install layout).
 */

import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';

const HELP = `Octipus — one nervous system, many arms.

Usage: octi <command> [options]

Commands:
  setup [--remote <url>]   Run the setup wizard (single entry point — TUI/non-TTY/remote)
  doctor [--json]          Environment health checks
  capabilities [install]   List or install optional tools (browser, mcp, …)
  models recommend         Recommend local models for this hardware (--install <id> to pull & bind)
  tui                      Launch terminal chat
  edit                     Launch the TUI editor
  start [--dev]            Start backend + web UI (delegates to bash dispatcher)
  stop                     Stop all Octipus processes
  restart [--dev]          Restart everything
  status                   Show running state
  logs [--web]             Tail backend logs
  open                     Open the web UI in a browser
  persona [show]           Print the resolved persona (use the web UI to edit)
  uninstall [--purge]      Remove Octipus (keeps data unless --purge; --dry-run to preview)
  version                  Print version
  help                     Print this banner
`;

interface PathResolution {
  projectDir: string | null;
  binOcti: string | null;
}

/**
 * Find the Octipus checkout. When the binary lives inside
 * <checkout>/bin/octi, `import.meta.dir` resolves the project. When
 * the user installed via the one-shot installer, the checkout is at
 * ~/.octipus/app. Otherwise the current cwd has to be the project
 * root (we look for package.json + the bin/ directory).
 */
function resolveProject(): PathResolution {
  const candidates: string[] = [];
  // 1) Sibling of this script (dev path)
  try {
    candidates.push(resolve(import.meta.dir, '..'));
  } catch { /* compiled binary has no import.meta */ }
  // 2) Installer default
  candidates.push(join(homedir(), '.octipus', 'app'));
  // 3) cwd
  candidates.push(process.cwd());
  // 4) OCTIPUS_HOME env var
  if (process.env.OCTIPUS_HOME) candidates.push(process.env.OCTIPUS_HOME);

  for (const dir of candidates) {
    if (!dir) continue;
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'bin'))) {
      const binOcti = join(dir, 'bin', 'octi');
      return { projectDir: dir, binOcti: existsSync(binOcti) ? binOcti : null };
    }
  }
  return { projectDir: null, binOcti: null };
}

function projectOrDie(): string {
  const { projectDir } = resolveProject();
  if (!projectDir) {
    process.stderr.write(
      'octi: could not locate the Octipus checkout. Set OCTIPUS_HOME or run from inside the repo.\n',
    );
    process.exit(2);
  }
  return projectDir;
}

async function delegateBash(args: string[]): Promise<never> {
  const { binOcti } = resolveProject();
  if (!binOcti) {
    process.stderr.write(
      `octi: this command needs the bash dispatcher at <project>/bin/octi but it was not found.\n`,
    );
    process.exit(2);
  }
  const code = await runInherit('bash', [binOcti, ...args], dirname(dirname(binOcti)));
  process.exit(code);
}

/** Spawn with the parent's stdio and resolve with the exit code. */
function runInherit(command: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit', cwd });
    child.on('close', (code, signal) => resolve(code ?? (signal ? 128 : 1)));
    child.on('error', () => resolve(127));
  });
}

async function delegateScript(scriptRelPath: string, args: string[]): Promise<never> {
  const projectDir = projectOrDie();
  const scriptPath = join(projectDir, scriptRelPath);
  if (!existsSync(scriptPath)) {
    process.stderr.write(`octi: script not found at ${scriptPath}\n`);
    process.exit(2);
  }
  const code = await runInherit('npx', ['tsx', '--import', './scripts/md-loader.mjs', scriptPath, ...args], projectDir);
  process.exit(code);
}

async function runDoctor(args: string[]): Promise<never> {
  return delegateScript('scripts/doctor.ts', args);
}

async function runInit(args: string[]): Promise<never> {
  // Single unified wizard — handles TTY, non-TTY (CI / Docker), and
  // remote (`--remote <url>`) modes itself. No TTY branching here.
  return delegateScript('scripts/setup-wizard.ts', args);
}

async function runCapabilities(args: string[]): Promise<never> {
  // List / install via the running backend. The backend's
  // /api/capabilities route owns the truth (probed once at boot, kept
  // current by installs). When the backend is down we surface a hint
  // rather than running probes a second way that could diverge.
  const port = process.env.API_PORT || '3005';
  const base = `http://localhost:${port}`;
  const sub = args[0];

  if (!sub || sub === 'list' || sub === '--help' || sub === '-h') {
    if (sub === '--help' || sub === '-h') {
      process.stdout.write(
        'octi capabilities                  list installed/missing tools\n' +
        'octi capabilities install <id>     install a capability (e.g. browser, mcp)\n' +
        'octi capabilities install --all    install every missing capability with an installer\n',
      );
      process.exit(0);
    }
    try {
      const res = await fetch(`${base}/api/capabilities`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = (await res.json()) as Array<{ toolId: string; available: boolean; reason: string | null; version: string | null }>;
      for (const r of rows) {
        const mark = r.available ? '\x1b[32m✓\x1b[0m' : '\x1b[33m·\x1b[0m';
        const meta = r.available ? (r.version ?? '') : (r.reason ?? '');
        process.stdout.write(`  ${mark}  ${r.toolId.padEnd(16)}  ${meta}\n`);
      }
      process.exit(0);
    } catch (err) {
      process.stderr.write(`octi capabilities: backend unreachable at ${base} (${(err as Error).message}). Run \`octi start\` first.\n`);
      process.exit(1);
    }
  }

  if (sub === 'install') {
    const target = args[1];
    if (!target) {
      process.stderr.write('octi capabilities install: missing capability id (or pass --all).\n');
      process.exit(2);
    }
    try {
      if (target === '--all' || target === '--all-missing') {
        const res = await fetch(`${base}/api/capabilities/install-all-missing`, { method: 'POST' });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
        const out = (await res.json()) as Record<string, { ok: boolean; detail: string }>;
        for (const [id, r] of Object.entries(out)) {
          process.stdout.write(`  ${r.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[33m!\x1b[0m'}  ${id}  ${r.detail}\n`);
        }
        process.exit(0);
      }
      const res = await fetch(`${base}/api/capabilities/${target}/install`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      const r = (await res.json()) as { ok: boolean; detail: string };
      process.stdout.write(`${r.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[33m!\x1b[0m'} ${r.detail}\n`);
      process.exit(r.ok ? 0 : 1);
    } catch (err) {
      process.stderr.write(`octi capabilities install: ${(err as Error).message}\n`);
      process.exit(1);
    }
  }

  process.stderr.write(`octi capabilities: unknown subcommand "${sub}"\n`);
  process.exit(2);
}

async function runPersona(args: string[]): Promise<never> {
  // For now, just print the resolved persona. Editing happens via
  // /persona slash command in the TUI or the web UI persona page.
  if (args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(
      'octi persona — print the resolved persona for the current user.\n\n' +
      'To edit:\n' +
      '  • TUI:   /persona name <X>  /persona tone <X>  /persona say <fact>\n' +
      '  • Web:   open /persona in the dashboard\n' +
      '  • API:   GET/PATCH /api/persona\n',
    );
    process.exit(0);
  }
  // Best-effort: try a local backend probe.
  const port = process.env.API_PORT || '3005';
  const url = `http://localhost:${port}/api/persona`;
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${process.env.OCTIPUS_API_TOKEN || ''}` },
    });
    if (res.ok) {
      const data = await res.json() as Record<string, unknown>;
      process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      process.exit(0);
    }
    if (res.status === 401) {
      process.stderr.write(
        'octi persona: backend rejected auth. Set OCTIPUS_API_TOKEN or open the web UI.\n',
      );
      process.exit(1);
    }
    process.stderr.write(`octi persona: backend returned ${res.status}\n`);
    process.exit(1);
  } catch (err) {
    process.stderr.write(
      `octi persona: cannot reach backend at ${url} (${(err as Error).message}).\n` +
      'Start it with `octi start` first, or use the TUI: `octi tui`.\n',
    );
    process.exit(1);
  }
}

async function runVersion(): Promise<never> {
  const projectDir = resolveProject().projectDir;
  let version = '0.0.0';
  if (projectDir) {
    try {
      const text = readFileSync(join(projectDir, 'package.json'), 'utf8');
      version = (JSON.parse(text).version as string) || version;
    } catch {
      // No package.json — compiled binary may live outside a checkout.
    }
  }
  process.stdout.write(`Octipus v${version} (Node ${process.versions.node})\n`);
  process.exit(0);
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  const cmd = (command || 'help').toLowerCase();

  switch (cmd) {
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      process.exit(0);
      break;

    case 'version':
    case '--version':
    case '-v':
      await runVersion();
      break;

    case 'doctor':
      await runDoctor(rest);
      break;

    case 'init':
    case 'setup':
      await runInit(rest);
      break;

    case 'tui':
      await delegateScript('src/tui-pi/index.ts', rest);
      break;

    case 'edit':
      await delegateScript('src/tui-editor/index.ts', rest);
      break;

    case 'persona':
      await runPersona(rest);
      break;

    case 'capabilities':
    case 'caps':
      await runCapabilities(rest);
      break;

    case 'models':
      await delegateScript('scripts/models-recommend.ts', rest);
      break;

    case 'plugin':
    case 'plugins':
      await delegateScript('scripts/plugin.ts', rest);
      break;

    case 'start':
    case 'stop':
    case 'restart':
    case 'status':
    case 'logs':
    case 'open':
    case 'uninstall':
      await delegateBash([cmd, ...rest]);
      break;

    default:
      process.stderr.write(`octi: unknown command "${cmd}"\n\n${HELP}`);
      process.exit(1);
  }
}

await main();
