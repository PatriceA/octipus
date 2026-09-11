/**
 * Product-facing CLI adapter limits, shared by backend, web and TUI.
 * Pure: no node imports, so the web bundle can use it.
 */
export interface CliCapabilitySource {
  /** Whole result arrives at process exit (no streamed events). */
  bufferOutput?: boolean;
  /** How the CLI reaches its Octipus tools; defaults to a per-run MCP config. */
  toolBridge?: 'mcp' | 'terminal';
}

export function describeCliCapabilities(tool: CliCapabilitySource): string {
  const buffered = tool.bufferOutput === true;
  return `${tool.toolBridge === 'terminal' ? 'Octipus tools via terminal bridge' : 'Octipus tools via scoped MCP'} · visible plans and feedback · ` +
    `${buffered ? 'activity reported at completion' : 'streamed activity'}. ` +
    'Guidance arrives with the next Octipus tool response. ' +
    (buffered ? 'Late guidance is reported with the result and needs another message. ' : 'Late guidance can use a bounded follow-up turn. ') +
    'Octipus tool approvals use this session; vendor-native controls vary.';
}

/** Additive flags a managed (bridge-scoped) run accepts per adapter. Keyed by adapter identity, not model name. */
export const SCOPED_EXTRA_ARGS: Record<string, { flags: readonly string[]; values: Record<string, readonly string[]> }> = {
  'Claude Code': {
    flags: ['--no-session-persistence', '--disable-slash-commands', '--no-chrome'],
    values: { '--effort': ['low', 'medium', 'high', 'xhigh', 'max'] },
  },
  'Codex CLI': { flags: ['--strict-config'], values: { '--color': ['auto', 'always', 'never'] } },
  'Mistral Vibe': { flags: [], values: {} },
  Antigravity: { flags: ['--disable-slash-commands'], values: { '--effort': ['low', 'medium', 'high'] } },
};

/** Only additive options may accompany the managed run's security and IO flags. Throws with a safe message. */
export function validateScopedExtraArgs(adapter: string, args: readonly string[]): void {
  const policy = SCOPED_EXTRA_ARGS[adapter];
  const reject = () => {
    // Do not echo argument values: operator configuration can contain secrets.
    const allowed = policy ? [...policy.flags, ...Object.keys(policy.values)].join(', ') : '';
    throw new Error(`Unsupported extraArgs for managed ${adapter}. Allowed options: ${allowed || 'none'}. Configure model, permissions and budgets through their dedicated settings.`);
  };
  if (!policy) { if (args.length) reject(); return; }
  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    if (policy.flags.includes(argument)) continue;
    const equals = argument.indexOf('=');
    const flag = equals < 0 ? argument : argument.slice(0, equals);
    const values = Object.hasOwn(policy.values, flag) ? policy.values[flag] : undefined;
    if (!values) reject();
    const value = equals < 0 ? args[++i] : argument.slice(equals + 1);
    if (!values?.includes(value)) reject();
  }
}
