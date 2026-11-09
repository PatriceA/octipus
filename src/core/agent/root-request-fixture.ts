/**
 * The root agent's model request, assembled from the real pieces the product
 * uses — the role config, the `before-agent-start` hooks (the persona), the
 * delegation text, the prompt builder, the agent manager's install-tier split,
 * a real AgentWorker's tool ordering and deferral, and the native Anthropic
 * request builder — without a database, a session or a network.
 *
 * Shared by the prompt-cache layout tests (`install-tier-cache.test.ts`,
 * `tool-cache-order.test.ts`) and `scripts/measure-prompt-cache.ts`, so the
 * request the script measures against the live API is the one the tests pin.
 * Nothing in the product imports this module.
 */
import type { ToolAdvertisement, ToolHandler } from '@/core/agent-base';
import { AgentWorker } from '@/core/agent-worker';
import type { AgentMessage } from '@/core/types';
import type { CompletionOptions } from '@/models/litellm-client';
import { AnthropicProvider } from '@/models/providers/anthropic-provider';
import { VOLATILE_MARKER } from '@/models/providers/prompt-cache';
import delegationPrompt from './delegation-prompt.md';
import { type BuildSystemPromptOptions, getAgentHooks } from './hooks';
import { asTrailingBlock, PromptBuilder, splitSharedPrefix } from './prompt-builder';
import { getRoleConfig } from './roles';
import { buildAgentContext } from './context';
import { buildDelegationPolicy, splitHookedRolePrompt } from './root-runner';
import { ROOT_ROLE } from './types';

/** A fixed turn-context block: the date the root runner puts first in the turn tier. */
export const FIXTURE_TURN_DATE = '\n\nCURRENT DATE & TIME: Sun, 08 Nov 2026 12:00:00 GMT';

/** What the `before-agent-start` hooks make of the role prompt. */
export type RolePromptHook = (input: BuildSystemPromptOptions) => Promise<string>;

/** The registered `before-agent-start` hooks, as the root runner fires them. */
export const fireAgentStartHooks: RolePromptHook = async (input) => (await getAgentHooks().fire('before-agent-start', input)).systemPrompt;

export interface RootPromptOptions {
  userId: string;
  /** The workspace root, in the session tier. */
  workspace: string;
  isLite?: boolean;
  /** The turn tier (date first). Defaults to `FIXTURE_TURN_DATE`. */
  turnContext?: string;
  /** Defaults to the registered hooks (`fireAgentStartHooks`). */
  hook?: RolePromptHook;
}

/** The root runner's assembly, in its order, for one user's turn. */
export async function assembleRootPrompt(options: RootPromptOptions): Promise<PromptBuilder> {
  const { userId, workspace, isLite = false, turnContext = FIXTURE_TURN_DATE, hook = fireAgentStartHooks } = options;
  const config = getRoleConfig(ROOT_ROLE);
  const base = isLite ? (config.liteSystemPromptTemplate ?? config.systemPromptTemplate) : config.systemPromptTemplate;
  const hookInput: BuildSystemPromptOptions = { role: ROOT_ROLE, root: true, userId, sessionId: `s-${userId}`, workspaceId: null, systemPrompt: base };
  const split = splitHookedRolePrompt(base, await hook(hookInput));
  if (!split) throw new Error('role prompt hook output not recognised');
  const prompt = new PromptBuilder()
    .add('install', 'role-prompt', split.install)
    .add('install', 'delegation-policy', buildDelegationPolicy(isLite));
  if (!isLite) prompt.add('install', 'delegation-mechanics', `\n\n${delegationPrompt}`);
  return prompt
    .add('user', 'persona', asTrailingBlock(split.user))
    .add('session', 'workspace-listing', `\nWORKSPACE: Root is ${workspace}`, { drifts: true })
    .add('turn', 'turn-context', turnContext);
}

/**
 * What the agent manager hands the worker: the install tier as a system
 * message flagged `cacheBreak`, then the rest of the static prompt. The turn
 * tier is returned apart: the worker moves it into the user message
 * (`AgentWorker.addSystemMessage` / `addUserMessage`).
 */
export function rootSystemMessages(prompt: PromptBuilder): { messages: AgentMessage[]; turnContext: string } {
  const split = splitSharedPrefix(prompt.build(), prompt.installPrefix());
  if (!split) throw new Error('no install split');
  const at = split.rest.match(VOLATILE_MARKER)?.index ?? split.rest.length;
  return {
    messages: [
      { role: 'system', content: split.shared, cacheBreak: true, timestamp: new Date(0) },
      { role: 'system', content: split.rest.slice(0, at), timestamp: new Date(0) },
    ],
    turnContext: split.rest.slice(at),
  };
}

/** A tool handler with a small schema, for fixtures that need a name and a group only. */
export function fixtureHandler(name: string, toolId?: string, description = `${name} does its thing`): ToolHandler {
  return { name, toolId, description, parameters: { type: 'object', properties: { q: { type: 'string' } } }, execute: async () => null };
}

export interface RequestTools {
  declarableTools: NonNullable<CompletionOptions['tools']>;
  sharedToolCount: number;
  deferredTools?: string[];
}

/**
 * The tool declarations a real AgentWorker sends for `handlers` (registered
 * in that order): cache order, the shared count, and — first-party Claude on
 * the lazy path with `agent.nativeToolSearch` on — the deferred names.
 */
export function workerRequestTools(
  userId: string,
  handlers: ToolHandler[],
  advertisement: ToolAdvertisement,
  model: { provider?: string; modelId: string } = { provider: 'anthropic', modelId: 'claude-opus-5-5' },
): RequestTools {
  const ctx = buildAgentContext({
    id: `w-${userId}`, sessionId: '00000000-0000-0000-0000-000000000000', userId, topic: 't', model: model.modelId, role: 'general',
    scope: { workspaceId: null, space: null, trigger: 'user', funding: 'own' },
  });
  const worker = new AgentWorker(ctx, { maxIterations: 1, contextWindowSize: 100_000, timeout: 60_000, maxTokenBudget: 0, toolOutputSoftCap: 1000, toolAdvertisement: advertisement });
  worker.registerTools(handlers);
  return (worker as unknown as { requestTools(m: { provider?: string; modelId: string }): RequestTools }).requestTools(model);
}

/** The body `AnthropicProvider` sends on its native path for `options` (non-streaming). */
export function nativeRequestBody(options: CompletionOptions): Record<string, unknown> {
  const provider = new AnthropicProvider() as unknown as { buildNativeBody(o: CompletionOptions, stream: boolean): Record<string, unknown> };
  return provider.buildNativeBody(options, false);
}

/** How many `cache_control` breakpoints a request body carries. */
export const countBreakpoints = (body: unknown): number => JSON.stringify(body).split('"cache_control"').length - 1;
