#!/usr/bin/env bun
/**
 * `octi` — TypeScript dispatcher.
 *
 * Compiled into a static binary via `bun build --compile`. The
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
 *   - tui      — `bun run src/tui-pi/index.ts`
 *   - edit     — `bun run src/tui-editor/index.ts`
 *
 * Commands delegated to the bash dispatcher (`bin/octi`) when present:
 *   - start, stop, restart, status, logs, open
 * These manage PIDs, log files, port-kills, and other shell-heavy
 * tasks — porting them in full lives behind a follow-up. The
 * compiled binary still works for them as long as the user's clone
 * ships the bash script alongside (the standard install layout).
 */

import { existsSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';

const HELP = `Octipus — one nervous system, eight arms.

Usage: octi <command> [options]

Commands:
  doctor [--json]   Environment health checks
  init              Run the setup wizard (storage, base model, security keys)
  tui               Launch terminal chat
  edit              Launch the TUI editor
  start [--dev]     Start backend + web UI (delegates to bash dispatcher)
  stop              Stop all Octipus processes
  restart [--dev]   Restart everything
  status            Show running state
  logs [--web]      Tail backend logs
  open              Open the web UI in a browser
  persona [show]    Print the resolved persona (use the web UI to edit)
  version           Print version
  help              Print this banner
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
  const proc = Bun.spawn(['bash', binOcti, ...args], {
    stdio: ['inherit', 'inherit', 'inherit'],
    cwd: dirname(dirname(binOcti)),
  });
  const code = await proc.exited;
  process.exit(code);
}

async function delegateBun(scriptRelPath: string, args: string[]): Promise<never> {
  const projectDir = projectOrDie();
  const scriptPath = join(projectDir, scriptRelPath);
  if (!existsSync(scriptPath)) {
    process.stderr.write(`octi: script not found at ${scriptPath}\n`);
    process.exit(2);
  }
  const proc = Bun.spawn(['bun', 'run', scriptPath, ...args], {
    stdio: ['inherit', 'inherit', 'inherit'],
    cwd: projectDir,
  });
  const code = await proc.exited;
  process.exit(code);
}

async function runDoctor(args: string[]): Promise<never> {
  return delegateBun('scripts/doctor.ts', args);
}

async function runInit(args: string[]): Promise<never> {
  const projectDir = projectOrDie();
  // The TUI-based init wizard ships under scripts/init.ts and falls
  // back to the legacy inquirer flow at scripts/setup.ts when the
  // terminal isn't capable enough (CI, dumb terminals).
  const tuiInit = join(projectDir, 'scripts', 'init.ts');
  const legacySetup = join(projectDir, 'scripts', 'setup.ts');
  const tty = Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY);
  if (!tty || process.env.OCTIPUS_INIT === 'legacy' || !existsSync(tuiInit)) {
    return delegateBun('scripts/setup.ts', args);
  }
  // Modern path: pi-tui wizard
  void legacySetup;
  return delegateBun('scripts/init.ts', args);
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
      const text = await Bun.file(join(projectDir, 'package.json')).text();
      version = (JSON.parse(text).version as string) || version;
    } catch {
      // No package.json — compiled binary may live outside a checkout.
    }
  }
  process.stdout.write(`Octipus v${version} (Bun ${Bun.version})\n`);
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
      await delegateBun('src/tui-pi/index.ts', rest);
      break;

    case 'edit':
      await delegateBun('src/tui-editor/index.ts', rest);
      break;

    case 'persona':
      await runPersona(rest);
      break;

    case 'start':
    case 'stop':
    case 'restart':
    case 'status':
    case 'logs':
    case 'open':
      await delegateBash([cmd, ...rest]);
      break;

    default:
      process.stderr.write(`octi: unknown command "${cmd}"\n\n${HELP}`);
      process.exit(1);
  }
}

await main();
