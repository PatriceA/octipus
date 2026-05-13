/**
 * Entry point for the pi-tui-based Octipus editor surface.
 *
 *   bun run src/tui-editor/index.ts [--project /path]
 *
 * Connects to the gateway (default API_PORT from .env), boots the
 * editor + chat hybrid, restores persisted layout/buffers from
 * ~/.octipus/tui-editor.json.
 */
import { resolve } from 'node:path';
import { OctipusEditorApp } from './app';
import { createRuntime } from '@/tui-pi/runtime';

export interface LaunchEditorOptions {
  gatewayUrl?: string;
  projectPath?: string;
}

export async function launchOctipusEditor(options: LaunchEditorOptions = {}): Promise<void> {
  const runtime = createRuntime({
    gatewayUrl: options.gatewayUrl,
    title: 'Octipus Editor',
  });
  const app = new OctipusEditorApp(runtime.tui, {
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
  void launchOctipusEditor({ projectPath });
}
