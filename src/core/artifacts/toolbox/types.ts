/**
 * Live-artifacts toolbox — typed contracts for collectors, transforms, widgets,
 * and exporters. Toolbox tools are NOT agent tools — they are named, invoked
 * inside the artifact pipeline (refresh / render / export), not by the LLM in
 * chat. The agent picks them by name through the discovery tools in
 * `src/tools/artifacts-toolbox/`.
 */

import type { AgentContext } from '@/core/types';

export type ToolboxFamily = 'collect' | 'transform' | 'widget' | 'export';

/** Permission tier mirrors the BaseTool permission action levels. */
export type ToolboxPermissionLevel = 'ALLOW' | 'ASK';

export interface ToolboxParamSpec {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description: string;
  required?: boolean;
  default?: unknown;
  enum?: readonly unknown[];
  /** Free-form example value used by `art_toolbox_describe`. */
  example?: unknown;
}

export interface ToolboxExample {
  /** One-line summary of the example case. */
  summary: string;
  /** Params object that would be passed in. */
  params: Record<string, unknown>;
}

/**
 * Context passed to every toolbox execution. Strict subset of AgentContext —
 * collectors/transforms/widgets don't see the full agent session, only the
 * principal whose credentials gate vault access and the workspace id.
 */
export interface ToolboxContext {
  /** Principal id whose vault entries / ACLs are used. */
  principalId: string;
  /** Workspace the artifact lives in. */
  workspaceId: string;
  /** Artifact id, when known (refresh time). Some validators run without. */
  artifactId?: string;
  /** Source/transform/widget name within the artifact. */
  nodeName?: string;
}

export interface ToolboxTool<P = Record<string, unknown>, R = unknown> {
  /** Stable id, e.g. `art_collect_http_json`. Matches folder + file name pattern. */
  readonly id: string;
  readonly family: ToolboxFamily;
  /** One-line, indexable description used by list + search. */
  readonly description: string;
  /** Lowercase keywords concatenated for substring search; embeddings come later. */
  readonly keywords: readonly string[];
  /** Parameter schema, validated before execute. */
  readonly params: Record<string, ToolboxParamSpec>;
  /** What the tool returns, free-form description used in describe(). */
  readonly returns: string;
  /** Worked examples shown by describe(). */
  readonly examples?: readonly ToolboxExample[];
  /** Default permission tier on first invocation per principal/host. */
  readonly defaultPermission: ToolboxPermissionLevel;
  /** Optional notes / gotchas surfaced by describe(). */
  readonly tips?: readonly string[];

  /**
   * Execute the tool. Implementations MUST throw on bad input; the registry
   * does basic shape checking via `params` but tools are responsible for
   * semantic validation. No silent fallbacks (CLAUDE.md house rule #1).
   */
  execute(params: P, ctx: ToolboxContext, agentCtx?: AgentContext): Promise<R>;
}

/** Compact manifest returned by `art_toolbox_list` — minimal tokens. */
export interface ToolboxIndexEntry {
  id: string;
  family: ToolboxFamily;
  description: string;
}

/** Full manifest returned by `art_toolbox_describe`. */
export interface ToolboxDescription extends ToolboxIndexEntry {
  keywords: readonly string[];
  params: Record<string, ToolboxParamSpec>;
  returns: string;
  examples: readonly ToolboxExample[];
  defaultPermission: ToolboxPermissionLevel;
  tips: readonly string[];
}
