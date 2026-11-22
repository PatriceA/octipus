/**
 * Terminal settings: how the chat and the editor use the screen and the mouse.
 *
 * Read the way the keybindings are: a JSON file under `~/.octipus/`, once at
 * launch — `~/.octipus/tui.json`, next to `keybindings.json`:
 *
 *   { "mouse": "native" }
 *
 * `tui.mouse` (the `mouse` key of that file, or `--mouse`):
 *   - `app` (default): the app takes mouse reports. The wheel scrolls the pane
 *     under the pointer, a drag selects transcript text and copies it on
 *     release; the terminal's override key (Shift in most terminals, Option
 *     in iTerm2 and Terminal.app) still gives the terminal's own selection.
 *   - `native`: no mouse reporting. Selection is the terminal's, with no
 *     modifier. Alternate-scroll mode (`?1007`) makes the wheel arrive as
 *     Up/Down, which scroll the transcript while the composer is empty.
 *   - `off`: no mouse reporting and no alternate scroll.
 *
 * `--inline` draws in the terminal's normal buffer instead of the alternate
 * screen, for people who want native scrollback (the transcript is then
 * scrolled by the app, as before).
 *
 * A bad value is an error at launch, not a silent default: the user asked
 * for something and would otherwise not get it without knowing.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { NOTIFY_METHODS, type NotifyMethod } from './attention';

export const MOUSE_MODES = ['app', 'native', 'off'] as const;
export type MouseMode = (typeof MOUSE_MODES)[number];
export type ScreenMode = 'alt' | 'inline';

export interface TerminalSettings {
  mouse: MouseMode;
  screen: ScreenMode;
}

const fileSchema = z.object({
  mouse: z.enum(MOUSE_MODES).optional(),
  /** How to notify when a turn ends or a decision waits while the terminal is in the background (`attention.ts`). */
  notify: z.enum(NOTIFY_METHODS).optional(),
}).strict();

/** Everything `~/.octipus/tui.json` may hold. */
export type SettingsFile = z.infer<typeof fileSchema>;

const CHOICES: Record<string, readonly string[]> = { mouse: MOUSE_MODES, notify: NOTIFY_METHODS };

export const DEFAULT_SETTINGS_PATH = join(homedir(), '.octipus', 'tui.json');

/** The settings file's values; `{}` when there is none. Throws, naming the file, when it is malformed. */
export function readSettingsFile(path: string = DEFAULT_SETTINGS_PATH): SettingsFile {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = fileSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const key = String(issue?.path[0] ?? '');
    const choices = Object.entries(CHOICES).filter(([name]) => !key || key === name || !(key in CHOICES)).map(([name, values]) => `${name} is one of ${values.join(', ')}`);
    throw new Error(`${path}: ${issue?.path.join('.') || 'settings'}: ${issue?.message ?? 'invalid'} (${choices.join('; ')})`);
  }
  return result.data;
}

/** `--inline` and `--mouse <mode>` from the command line. Throws on an unknown mode. */
export function parseTerminalArgs(args: string[]): Partial<TerminalSettings> {
  const parsed: Partial<TerminalSettings> = {};
  if (args.includes('--inline')) parsed.screen = 'inline';
  const at = args.indexOf('--mouse');
  if (at >= 0) {
    const value = args[at + 1];
    if (!value || !(MOUSE_MODES as readonly string[]).includes(value)) {
      throw new Error(`--mouse takes one of ${MOUSE_MODES.join(', ')}${value ? ` (got "${value}")` : ''}`);
    }
    parsed.mouse = value as MouseMode;
  }
  return parsed;
}

/** Flags win over the file; the file wins over the defaults. */
export function resolveTerminalSettings(args: string[], path: string = DEFAULT_SETTINGS_PATH): TerminalSettings {
  const file = readSettingsFile(path);
  return { mouse: 'app', screen: 'alt', ...(file.mouse ? { mouse: file.mouse } : {}), ...parseTerminalArgs(args) };
}

/** The notification method from the file; `auto` without one. */
export function readNotifySetting(path: string = DEFAULT_SETTINGS_PATH): NotifyMethod {
  return readSettingsFile(path).notify ?? 'auto';
}
