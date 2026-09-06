/**
 * The built-in tool folders.
 *
 * Convention (matches the roles drop-folder pattern):
 *
 *   src/tools/<name>/index.ts   — exports any of:
 *     • a singleton instance of a BaseTool subclass (preferred), or
 *     • a default-exported BaseTool subclass that the loader will `new`
 *
 * Adding a tool is a folder plus one line in `MODULES` below.
 *
 * That one line is the point. This used to `readdirSync` its own directory and
 * dynamically import each `index.ts`, which resolves into `dist/` once bundled:
 * every built-in tool silently disappeared and the registry came up holding
 * only the plugins. Silently, because a folder with no tool export is a normal
 * skip. Static imports are what a bundler can see, and `registerBuiltinTools`
 * now refuses to come up with an empty registry rather than degrading to one.
 */
import { toolLogger } from '@/utils/logger';
import * as ArtifactsModule from './artifacts';
import * as ArtifactsToolboxModule from './artifacts-toolbox';
import * as AtlassianModule from './atlassian';
import { BaseTool } from './base-tool';
import * as BrowserModule from './browser';
import * as BrowserExtModule from './browser-ext';
import * as DataModule from './data';
import * as DockerModule from './docker';
import * as DocumentsModule from './documents';
import * as EmailProcessorModule from './email-processor';
import * as FilesystemModule from './filesystem';
import * as GitModule from './git';
import * as GithubModule from './github';
import * as GitlabModule from './gitlab';
import * as GoogleWorkspaceModule from './google-workspace';
import * as KnowledgeModule from './knowledge';
import * as MessagingModule from './messaging';
import * as Microsoft365Module from './microsoft365';
import * as NotesModule from './notes';
import * as PlanModule from './plan';
import * as ProfilesModule from './profiles';
import * as RepoRegistryModule from './repo-registry';
import * as SchedulingModule from './scheduling';
import * as ShellModule from './shell';
import * as SkillDistillModule from './skill-distill';
import * as TaskStateModule from './task-state';
import * as TasksModule from './tasks';
import * as VisualModule from './visual';
import * as VoiceModule from './voice';
import * as WebsearchModule from './websearch';

/** Folder name → module. Order is irrelevant; the registry keys by tool id. */
const MODULES: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ['artifacts', ArtifactsModule],
  ['artifacts-toolbox', ArtifactsToolboxModule],
  ['atlassian', AtlassianModule],
  ['browser', BrowserModule],
  ['browser-ext', BrowserExtModule],
  ['data', DataModule],
  ['docker', DockerModule],
  ['documents', DocumentsModule],
  ['email-processor', EmailProcessorModule],
  ['filesystem', FilesystemModule],
  ['git', GitModule],
  ['github', GithubModule],
  ['gitlab', GitlabModule],
  ['google-workspace', GoogleWorkspaceModule],
  ['knowledge', KnowledgeModule],
  ['messaging', MessagingModule],
  ['microsoft365', Microsoft365Module],
  ['notes', NotesModule],
  ['plan', PlanModule],
  ['profiles', ProfilesModule],
  ['repo-registry', RepoRegistryModule],
  ['scheduling', SchedulingModule],
  ['shell', ShellModule],
  ['skill-distill', SkillDistillModule],
  ['task-state', TaskStateModule],
  ['tasks', TasksModule],
  ['visual', VisualModule],
  ['voice', VoiceModule],
  ['websearch', WebsearchModule],
];

export interface DiscoveredTool {
  folder: string;
  tool: BaseTool;
}

/** Every built-in tool, in folder order. */
export async function discoverTools(): Promise<DiscoveredTool[]> {
  const found: DiscoveredTool[] = [];

  for (const [folder, mod] of MODULES) {
    const tool = pickTool(mod);
    if (tool) {
      found.push({ folder, tool });
    } else {
      // Not an error: a folder may hold only helpers or types.
      toolLogger.debug({ folder }, 'tool discovery: no BaseTool export — skipping');
    }
  }

  return found;
}

/** How many folders are wired in — used to sanity-check the count at boot. */
export const BUILTIN_TOOL_FOLDERS = MODULES.length;

function pickTool(mod: Record<string, unknown>): BaseTool | null {
  // Prefer the conventional `<name>Tool` singleton instance over class exports.
  for (const value of Object.values(mod)) {
    if (value instanceof BaseTool) return value;
  }
  // Default-exported class that needs constructing (e.g. VoiceCallTool).
  const def = (mod as { default?: unknown }).default;
  if (typeof def === 'function') {
    try {
      const inst = new (def as new () => unknown)();
      if (inst instanceof BaseTool) return inst;
    } catch {
      // not constructible without args — skip
    }
  }
  // Fall back: any class export whose name ends with "Tool" and is constructible.
  for (const [key, value] of Object.entries(mod)) {
    if (typeof value !== 'function' || !key.endsWith('Tool')) continue;
    try {
      const inst = new (value as new () => unknown)();
      if (inst instanceof BaseTool) return inst;
    } catch {
      // skip
    }
  }
  return null;
}
