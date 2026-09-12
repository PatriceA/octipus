/**
 * Octipus slash command registry surfaced in the composer's
 * autocomplete dropdown.
 *
 * The list mirrors the gateway-side `CommandRegistry` built-ins
 * (`src/core/gateway/commands.ts`) plus a handful of TUI-only
 * commands handled in `app.ts` without hitting the gateway.
 *
 * `slash-commands.sync.test.ts` pins the gateway half of this list to the
 * registry, so a command added on either side without the other fails CI.
 * Extension-registered commands still only appear in `/help`.
 */
import type { SlashCommand } from '@mariozechner/pi-tui';

/** Where the command runs — drives Phase 4 styling and tests. */
export type SlashCommandSource = 'tui' | 'gateway';

export interface OctipusSlashCommand extends SlashCommand {
  source: SlashCommandSource;
  /** Optional aliases the gateway dispatcher recognizes. Stored for `/help` rendering only. */
  aliases?: string[];
}

const tui = (entry: Omit<OctipusSlashCommand, 'source'>): OctipusSlashCommand => ({ ...entry, source: 'tui' });
const gw = (entry: Omit<OctipusSlashCommand, 'source'>): OctipusSlashCommand => ({ ...entry, source: 'gateway' });

export const OCTIPUS_SLASH_COMMANDS: OctipusSlashCommand[] = [
  // ── TUI-local ───────────────────────────────────────────────────
  tui({ name: 'exit',     description: 'Quit the TUI' }),
  tui({ name: 'quit',     description: 'Quit the TUI' }),
  tui({ name: 'project',  description: 'Show or set the active project path',
        argumentHint: '<path>' }),
  tui({ name: 'login',    description: 'Sign in to your Octipus account (memories, vault secrets, settings)' }),
  tui({ name: 'logout',   description: 'Sign out — falls back to the local machine account' }),
  tui({ name: 'whoami',   description: 'Show which account this terminal is acting as' }),
  tui({ name: 'workspace', description: 'Show or switch the active workspace (- for default)',
        argumentHint: '<slug|->' }),
  tui({ name: 'resume',   description: 'Reopen a session from /sessions by number or id',
        argumentHint: '<n|id>' }),
  tui({ name: 'hotkeys',  description: 'Show the chat shell keybindings' }),

  // ── Gateway built-ins (src/core/gateway/commands.ts) ───────────
  gw({ name: 'help',      description: 'List available commands',                            aliases: ['h', '?'] }),
  gw({ name: 'status',    description: 'Show current session status, agents, and expert',   aliases: ['s'] }),
  gw({ name: 'expert',    description: 'Switch expert or list available experts',
       argumentHint: '<name|reset>',                                                         aliases: ['e'] }),
  gw({ name: 'abort',     description: 'Cancel running agents',                              aliases: ['stop', 'cancel'] }),
  { name: 'plan-hide', description: 'Collapse the expanded plan', source: 'tui' },
  gw({ name: 'work-plan', description: 'Show the current work plan, evidence, and feedback' }),
  gw({ name: 'plan-feedback', description: 'Give feedback on the visible work plan', argumentHint: '<change>' }),
  gw({ name: 'plan',      description: 'Toggle plan mode — explore and propose, change nothing',
       argumentHint: '[on|off]' }),
  gw({ name: 'compact',   description: 'Compact session context (optional focus instructions)',
       argumentHint: '[focus]' }),
  gw({ name: 'clear',     description: 'Reset rootAgent context and clear the chat',     aliases: ['cls', 'reset'] }),
  gw({ name: 'cost',      description: 'Show cumulative token usage and cost' }),
  gw({ name: 'sessions',  description: 'List your recent sessions' }),
  gw({ name: 'history',   description: 'Replay this session\'s conversation' }),
  gw({ name: 'persona',   description: 'Configure the root agent persona' }),
  gw({ name: 'proposals', description: 'Review distilled skill/expert proposals — list, approve, reject',
       argumentHint: '[approve|reject] [n]',                                                 aliases: ['skills-proposals'] }),
  gw({ name: 'mcp',       description: 'MCP servers — status, or reconnect one after restarting it',
       argumentHint: '[reconnect] [server]' }),
  gw({ name: 'diff',      description: 'Show git diff for workspace changes' }),
  gw({ name: 'changes',   description: 'Review workspace changes — list, or a file diff',
       argumentHint: '[file]' }),
  gw({ name: 'reload-extensions', description: 'Re-discover and reload user extensions',     aliases: ['reload'] }),
  gw({ name: 'version',   description: 'Show Octipus version and build info',                aliases: ['v'] }),
];

/** Lookup the command record (or alias target) by name. Returns undefined when unknown. */
export function findSlashCommand(name: string): OctipusSlashCommand | undefined {
  const lower = name.toLowerCase();
  for (const cmd of OCTIPUS_SLASH_COMMANDS) {
    if (cmd.name === lower) return cmd;
    if (cmd.aliases?.includes(lower)) return cmd;
  }
  return undefined;
}
