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

/**
 * Which CLIs can continue a previous session, and how the id is obtained.
 *
 * `caller-minted` means we generate the id and pass it on the first run
 * (Claude's `--session-id <uuid>`), so there is nothing to scrape and no
 * window where a run has no id. `captured` means the CLI assigns the id and
 * we read it out of its machine output (Codex `thread.started.thread_id`).
 *
 * Antigravity is deliberately absent: the installed 1.1.5 print mode emits no
 * conversation id at all, and handing it a stale id starts a fresh
 * conversation SILENTLY, which is worse than not reusing. Vibe is absent
 * because its resume depends on `log_interactions` staying enabled in the
 * user's own config, which we do not control.
 */
export const CLI_RESUME: Record<string, { style: 'caller-minted' | 'captured'; flag: string }> = {
  'Claude Code': { style: 'caller-minted', flag: '--resume' },
  'Codex CLI': { style: 'captured', flag: 'resume' },
};

export function canResume(adapterKey: string): boolean {
  return adapterKey in CLI_RESUME;
}

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
