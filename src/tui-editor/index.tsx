/**
 * TUI editor entry point.
 *
 * Mirrors the launch shape of `src/tui/index.tsx` so a future
 * "switch surface" command can swap one for the other without
 * touching the binary path.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render } from 'ink';
import { TuiEditorApp } from './app';

const SYNC_START = '\x1b[?2026h';
const SYNC_END = '\x1b[?2026l';

function installSyncOutput(): void {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let inRender = false;
  process.stdout.write = function (chunk: unknown, ...args: unknown[]) {
    if (!inRender) {
      inRender = true;
      originalWrite(SYNC_START);
      queueMicrotask(() => {
        originalWrite(SYNC_END);
        inRender = false;
      });
    }
    return (originalWrite as (...a: unknown[]) => boolean)(chunk, ...args);
  } as typeof process.stdout.write;
}

function getApiPort(): string {
  if (process.env.API_PORT) return process.env.API_PORT;
  const envPath = resolve(import.meta.dir, '../../.env');
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, 'utf-8');
    const match = content.match(/^API_PORT=(\d+)/m);
    if (match) return match[1];
    const portMatch = content.match(/^PORT=(\d+)/m);
    if (portMatch) return portMatch[1];
  }
  return '3005';
}

export function launchTuiEditor(options?: { gatewayUrl?: string; projectPath?: string }): void {
  const port = getApiPort();
  const gatewayUrl = options?.gatewayUrl || `ws://localhost:${port}/gateway`;
  installSyncOutput();
  render(
    <TuiEditorApp gatewayUrl={gatewayUrl} projectPath={options?.projectPath} />,
    { exitOnCtrlC: true },
  );
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let projectPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--project' || args[i] === '-p') && args[i + 1]) {
      projectPath = resolve(args[i + 1]);
      i++;
    }
  }
  launchTuiEditor({ projectPath });
}
