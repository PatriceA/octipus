/**
 * Tool actions whose network the egress policy cannot judge
 * (docs/EGRESS-POLICY.md#not-covered). Listed here once: the operator status
 * (`GET /api/settings/egress`) shows them, and under `requireEnforcement`
 * `BaseTool` refuses them instead of letting them through.
 */
import { activeEgressPolicy, egressPolicyActive } from './egress-policy';

export interface UnjudgedEgress {
  tool: string;
  actions: readonly string[];
  why: string;
}

export const UNJUDGED_EGRESS: readonly UnjudgedEgress[] = [
  { tool: 'docker', actions: ['compose_project', 'start_container', 'build_image', 'exec_command'], why: 'containers and image builds use the Docker daemon\'s network, not Octipus\'s' },
  { tool: 'browser-ext', actions: ['navigate', 'new_tab', 'evaluate', 'click', 'press_key', 'fill', 'select', 'drag', 'fill_login'], why: 'drives the user\'s own browser, whose requests do not pass through Octipus' },
  { tool: 'mcp_admin', actions: ['mcp_add_server'], why: 'an added MCP server is its own process with its own network' },
  { tool: 'test_container', actions: ['run'], why: 'the test container runs on Docker\'s bridge network, not through Octipus' },
];

/** CLI agents with vendor-native tools (not `octipusToolsOnly`): their tools run inside the vendor CLI. */
export const UNJUDGED_CLI_NATIVE_TOOLS = 'CLI-agent models with vendor-native tools (shell, web fetch inside the vendor CLI)';

/** Why `tool.action` must be refused under `requireEnforcement`, or null. */
export function unjudgedEgressRefusal(tool: string, action: string): string | null {
  const entry = UNJUDGED_EGRESS.find((e) => e.tool === tool && e.actions.includes(action));
  if (!entry) return null;
  const policy = activeEgressPolicy();
  if (!egressPolicyActive(policy) || !policy.requireEnforcement) return null;
  return `${tool}.${action} is refused: its network cannot be judged by the egress policy (${entry.why}), and security.egressPolicy.requireEnforcement is set.`;
}

/** Why a CLI agent with native tools must not run under `requireEnforcement`, or null. */
export function cliNativeToolsRefusal(octipusToolsOnly: boolean): string | null {
  if (octipusToolsOnly) return null;
  const policy = activeEgressPolicy();
  if (!egressPolicyActive(policy) || !policy.requireEnforcement) return null;
  return 'This CLI agent runs its vendor-native tools, whose network the egress policy cannot judge, and security.egressPolicy.requireEnforcement is set. Use a CLI that runs Octipus tools only, or a non-CLI model.';
}
