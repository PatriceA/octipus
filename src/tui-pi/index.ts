/**
 * Phase 1 entry for the pi-tui-based Octipus shell.
 *
 *   npx tsx src/tui-pi/index.ts [--project /path | /path]
 *
 * Builds the runtime, mounts OctipusTuiApp, connects to the gateway.
 * Once Phase 8 lands, `bin/octi tui` and `package.json#scripts.tui`
 * point here and the old src/tui/ tree is deleted.
 */
import { resolve } from 'node:path';
import { OctipusTuiApp } from './app';
import { createRuntime } from './runtime';

export interface LaunchOptions {
  gatewayUrl?: string;
  projectPath?: string;
}

export async function launchOctipusTui(options: LaunchOptions = {}): Promise<void> {
  const runtime = createRuntime({
    gatewayUrl: options.gatewayUrl,
    title: 'Octipus',
  });
  const app = new OctipusTuiApp(runtime.tui, {
    gatewayUrl: runtime.gatewayUrl,
    projectPath: options.projectPath,
    onShutdown: runtime.shutdown,
  });
  await app.start();
}

/**
 * Which directory this session is pinned to, from the argv the launcher left us.
 *
 * Accepts `--project <path>`, `-p <path>`, and a BARE path. The bare form is
 * not decoration: `bin/octi tui` ran `npm run tui --project "$PWD"` without a
 * `--` separator, so npm claimed the flag as its own config ("Unknown cli
 * config") and forwarded only the path. The flag-only parser then ignored it,
 * `projectPath` came out undefined, no project reached the session, and the
 * agent answered questions about "this directory" from the user's default
 * workspace — while the launcher's banner still named the directory you meant.
 * Silent and wrong is the worst pair, so both spellings resolve now.
 *
 * An explicit `--project` always wins, and only the FIRST bare argument is
 * considered — a stray positional must not be able to outrank the flag.
 */
export function parseProjectArg(args: string[]): string | undefined {
  let fromFlag: string | undefined;
  let fromPositional: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if ((arg === '--project' || arg === '-p') && args[i + 1]) {
      fromFlag = resolve(args[i + 1] as string);
      i++;
    } else if (!arg.startsWith('-') && arg !== '' && fromPositional === undefined) {
      // FIRST bare argument only. Last-one-wins over every positional let a
      // stray `octi tui somefile.txt` silently outrank the launcher's own
      // `--project "$PWD"` — the banner would still print the directory you
      // meant while the session pinned somewhere else, which is precisely the
      // failure this parser exists to close, arriving through a different slot.
      fromPositional = resolve(arg);
    }
  }
  // An explicit flag always wins: the positional is a fallback for launchers
  // whose flag was eaten before it reached us, not a competing spelling.
  return fromFlag ?? fromPositional;
}

if (import.meta.main) {
  void launchOctipusTui({ projectPath: parseProjectArg(process.argv.slice(2)) });
}
