/**
 * Octipus slash command registry surfaced in the composer's
 * autocomplete dropdown.
 *
 * The list mirrors the gateway-side `CommandRegistry` built-ins
 * (`src/core/gateway/commands.ts`) plus a handful of TUI-only
 * commands handled in `app.ts` without hitting the gateway.
 *
 * Phase 7 will replace this hardcoded list with a live snapshot
 * fetched from the gateway so extensions/skills/templates appear
 * automatically. Until then, we keep the static list close to
 * the truth and lean on `/help` for the authoritative roster.
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

  // ── Gateway built-ins (src/core/gateway/commands.ts) ───────────
  gw({ name: 'help',      description: 'List available commands',                            aliases: ['h', '?'] }),
  gw({ name: 'status',    description: 'Show current session status, agents, and expert',   aliases: ['s'] }),
  gw({ name: 'expert',    description: 'Switch expert or list available experts',
       argumentHint: '<name|reset>',                                                         aliases: ['e'] }),
  gw({ name: 'abort',     description: 'Cancel running agents',                              aliases: ['stop', 'cancel'] }),
  gw({ name: 'compact',   description: 'Compact session context (optional focus instructions)',
       argumentHint: '[focus]' }),
  gw({ name: 'clear',     description: 'Reset orchestrator context and clear the chat',     aliases: ['cls', 'reset'] }),
  gw({ name: 'cost',      description: 'Show cumulative token usage and cost' }),
  gw({ name: 'diff',      description: 'Show git diff for workspace changes' }),
  gw({ name: 'reload',    description: 'Re-discover and reload user extensions',             aliases: ['reload-extensions'] }),
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
