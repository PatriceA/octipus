/**
 * Phase 1 entry for the pi-tui-based Octipus shell.
 *
 *   bun run src/tui-pi/index.ts [--project /path]
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

if (import.meta.main) {
  const args = process.argv.slice(2);
  let projectPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--project' || args[i] === '-p') && args[i + 1]) {
      projectPath = resolve(args[i + 1]);
      i++;
    }
  }
  void launchOctipusTui({ projectPath });
}
