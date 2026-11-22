/** Node terminal bootstrap: the screen, mouse and clipboard, keybindings, connection defaults and shutdown. */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type ClipboardResult, copyToClipboard, type KeybindingsConfig, type KeybindingsManager, ProcessTerminal, type TUI,
  TuiAltScreen, TuiMainScreen,
} from '@/tui-kit';
import { defaultClipboardEnvironment } from '@/tui-kit/clipboard';
import { installTranscriptSearch, type TranscriptSearch } from '@/tui-kit/transcript-search';
import { mouseReportFilter, setMouseCapture } from './terminal-actions';
import { installOctipusKeybindings, loadOctipusKeybindings } from './keybindings';
import { type MouseMode, readNotifySetting, readThemeSetting, resolveTerminalSettings, type ScreenMode } from './settings';
import { setPalette } from './theme/defaults';
import { openerFor, openUrl } from './links';
import { Attention, FOCUS_REPORTING_OFF, FOCUS_REPORTING_ON, type NotifyMethod } from './attention';

export interface RuntimeOptions {
  /** Override the default WebSocket URL (otherwise built from the API port). */
  gatewayUrl?: string;
  /** Show the OS-level hardware cursor. Default false (we render our own). */
  showHardwareCursor?: boolean;
  /** Title set on the terminal window. */
  title?: string;
  /** `alt` (default): the alternate screen. `inline`: the normal buffer, the terminal keeps its scrollback. */
  screen?: ScreenMode;
  /** See `settings.ts`. Default: `~/.octipus/tui.json`, else `app`. */
  mouse?: MouseMode;
  /**
   * The surface draws its own full-height frame and scrolls its own panes
   * (the editor): the alternate screen's viewport keys (PageUp, Ctrl+Home,
   * Ctrl+Up…) go to the surface instead of scrolling a viewport it does not use.
   */
  ownsScrolling?: boolean;
  /** Turns a drag selection into the text that is copied (the chat leaves out the transcript's rail). */
  selectionText?: (text: string) => string;
  /** See `attention.ts`. Default: `notify` in `~/.octipus/tui.json`, else `auto`. */
  notify?: NotifyMethod;
}

export interface Runtime {
  tui: TUI;
  screen: ScreenMode;
  mouse: MouseMode;
  gatewayUrl: string;
  keybindings: KeybindingsManager;
  /** Restore the terminal, then print `farewell` (if any) to the normal buffer. */
  shutdown: (farewell?: string) => Promise<void>;
  setExitHandler: (handler: (signal: 'SIGINT' | 'SIGTERM') => void) => void;
  /** The clipboard chain (`@/tui-kit/clipboard`), writing OSC 52 to this terminal. */
  copy: (text: string) => Promise<ClipboardResult>;
  /**
   * Leave the screen, print `text` into the terminal's own scrollback (for
   * its search and selection), wait for a key, and come back.
   */
  dumpToScrollback: (text: string) => Promise<void>;
  /** The transcript search on the alternate screen (`/search`, Ctrl+F, Ctrl+Shift+F); absent inline and for the editor. */
  search?: TranscriptSearch;
  /** Focus, notifications and the window title. */
  attention: Attention;
}

/**
 * Read API port from the environment or checkout configuration.
 */
export function getApiPort(): string {
  if (process.env.API_PORT) return process.env.API_PORT;
  const envPath = resolve(import.meta.dirname, '../../.env');
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, 'utf-8');
    const match = content.match(/^API_PORT=(\d+)/m);
    if (match) return match[1];
    const portMatch = content.match(/^PORT=(\d+)/m);
    if (portMatch) return portMatch[1];
  }
  return '3005';
}

/** The part of `process` the exit guards use; a fake stands in for it in tests. */
export interface GuardedProcess {
  on(event: 'uncaughtException' | 'unhandledRejection' | 'exit' | 'SIGHUP', listener: (value: unknown) => void): unknown;
  exit(code: number): void;
  stderr: { write(text: string): unknown };
}

/**
 * Put the terminal back on every way out, not only SIGINT and SIGTERM.
 *
 * Without this a crash left the user's shell in raw mode with mouse reporting
 * on and the cursor hidden: every click printed an escape sequence and typing
 * did not echo. `restore` must be synchronous and idempotent — on `exit` only
 * synchronous work runs. The error is printed after the restore, so it lands
 * on a working terminal instead of inside the frame.
 */
export function installExitGuards(restore: () => void, proc: GuardedProcess = process): void {
  const fatal = (kind: string) => (error: unknown) => {
    restore();
    proc.stderr.write(`\n${kind}: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    proc.exit(1);
  };
  proc.on('uncaughtException', fatal('Uncaught exception'));
  proc.on('unhandledRejection', fatal('Unhandled rejection'));
  proc.on('exit', () => restore());
  // The terminal went away (window closed, SSH dropped): restore what can be, exit as a hangup.
  proc.on('SIGHUP', () => { restore(); proc.exit(129); });
}

/** Alternate scroll: on the alternate screen, the wheel arrives as Up/Down keys. */
const ALTERNATE_SCROLL_ON = '\x1b[?1007h';
const ALTERNATE_SCROLL_OFF = '\x1b[?1007l';
/** Erase the scrollback. The main-screen renderer sends it on every resize; it took the user's history before launch with it. */
const ERASE_SCROLLBACK = '\x1b[3J';
/** Save the window and icon titles on the terminal's title stack, and restore them (xterm; others ignore it). */
const TITLE_PUSH = '\x1b[22;0t';
const TITLE_POP = '\x1b[23;0t';
/** What the alternate-screen renderer flashes after a copy; replaced by what actually happened. */
const COPIED_FLASH = 'Copied!';

/** The viewport keys of the alternate screen, unbound for surfaces that scroll their own panes. */
function withoutViewportKeys(user: KeybindingsConfig): KeybindingsConfig {
  const ids = ['pageUp', 'pageDown', 'halfPageUp', 'halfPageDown', 'lineUp', 'lineDown', 'previousPrompt', 'nextPrompt', 'search', 'top', 'bottom'];
  return { ...Object.fromEntries(ids.map(id => [`tui.altScreen.${id}`, []])), ...user };
}

/**
 * The chat searches its transcript with Ctrl+F as well as pi-tui's
 * Ctrl+Shift+F: without the kitty keyboard protocol or modifyOtherKeys a
 * terminal sends the same byte for both, so Ctrl+Shift+F alone was often
 * unreachable. Ctrl+F stops moving the composer's cursor right (Right does).
 */
function withChatSearchKeys(user: KeybindingsConfig): KeybindingsConfig {
  return { 'tui.altScreen.search': ['ctrl+shift+f', 'ctrl+f'], ...user };
}

export function createRuntime(options: RuntimeOptions = {}): Runtime {
  const port = getApiPort();
  const gatewayUrl = options.gatewayUrl || `ws://localhost:${port}/gateway`;
  const settings = options.screen !== undefined && options.mouse !== undefined ? { screen: options.screen, mouse: options.mouse } : resolveTerminalSettings([]);
  const screen = options.screen ?? settings.screen;
  const mouse = options.mouse ?? settings.mouse;

  const notify = options.notify ?? readNotifySetting();
  // A fixed theme applies to both surfaces from the first frame; `auto` is the chat's to detect once the screen runs.
  const theme = readThemeSetting();
  if (theme !== 'auto') setPalette(theme);
  // The alternate screen with app mouse turns focus reporting on itself and
  // reads the reports (a focus loss ends a drag); everywhere else they are ours.
  const screenReportsFocus = screen === 'alt' && mouse === 'app';
  let attention: Attention | null = null;
  const terminal = new class extends ProcessTerminal {
    override start(onInput: (data: string) => void, onResize: () => void): void {
      super.start(data => { if (!attention?.observe(data) || screenReportsFocus) onInput(data); }, onResize);
      if (!screenReportsFocus) this.write(FOCUS_REPORTING_ON);
      // Inline: wheel reports for the app's own scrolling; Shift+drag stays native selection.
      if (screen === 'inline' && mouse === 'app') setMouseCapture(this, true);
      if (screen === 'alt' && mouse === 'native') this.write(ALTERNATE_SCROLL_ON);
    }
    override stop(): void {
      if (!screenReportsFocus) this.write(FOCUS_REPORTING_OFF);
      if (screen === 'inline' && mouse === 'app') setMouseCapture(this, false);
      if (screen === 'alt' && mouse === 'native') this.write(ALTERNATE_SCROLL_OFF);
      super.stop();
    }
    override write(data: string): void {
      super.write(screen === 'inline' ? data.replaceAll(ERASE_SCROLLBACK, '') : data);
    }
  }();
  const copy = (text: string) => copyToClipboard(text, defaultClipboardEnvironment(data => terminal.write(data)));
  attention = new Attention({ write: data => terminal.write(data), setTitle: title => terminal.setTitle(title), setProgramStatus: status => terminal.setProgramStatus(status) }, notify);

  let tui: TUI;
  let search: TranscriptSearch | undefined;
  if (screen === 'alt') {
    const selectionText = options.selectionText ?? ((text: string) => text);
    const alt = new class extends TuiAltScreen {
      copyNote: string | null = null;
      // The renderer flashes a bare "Copied!"; say which way the text went.
      override flash(message: string, durationMs?: number): void {
        const shown = message === COPIED_FLASH && this.copyNote ? this.copyNote : message;
        this.copyNote = null;
        super.flash(shown, durationMs);
      }
    }(terminal, options.showHardwareCursor ?? false, undefined, {
      mouse: mouse === 'app',
      scrollToEndIndicator: () => ' ↓ End: latest ',
      // The app gets the click, not the terminal: open a web link here; a local file's path is copied, never opened.
      openUrl: url => openUrl(url, message => alt.flash(message), openerFor(), copy),
      copySelection: async text => {
        const result = await copy(selectionText(text));
        if (!result.ok) return result.message;
        alt.copyNote = result.message;
        return true;
      },
    });
    tui = alt;
    if (!options.ownsScrolling) search = installTranscriptSearch(alt);
  } else {
    tui = new TuiMainScreen(terminal, options.showHardwareCursor ?? false);
    // Only the inline screen hands raw mouse reports to the app; the alternate screen parses them itself.
    if (mouse === 'app') tui.addInputListener(mouseReportFilter(tui));
  }
  const userBindings = loadOctipusKeybindings();
  const keybindings = installOctipusKeybindings(options.ownsScrolling ? withoutViewportKeys(userBindings) : withChatSearchKeys(userBindings));

  // The chat and the editor set the window title (`options.title`, `Attention`): save the user's first, put it back on the way out.
  terminal.write(TITLE_PUSH);
  if (options.title) terminal.setTitle(options.title);

  // tui.stop() leaves the alternate screen (or moves below the frame) and
  // shows the cursor; the terminal turns off mouse reporting, bracketed paste
  // and the keyboard protocol, and leaves raw mode. `preserveScreen` stops the
  // alternate-screen renderer from printing the whole document on the way out.
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    try { tui.stop({ preserveScreen: true }); } catch (error) {
      process.stderr.write(`Could not restore the terminal: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.stdout.write(TITLE_POP);
  };
  installExitGuards(restore);

  let shuttingDown = false;
  const shutdown = async (farewell?: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    restore();
    if (farewell) process.stdout.write(`${farewell.replace(/\n/g, '\r\n')}\r\n`);
    try { await terminal.drainInput(800, 50); } catch (error) {
      process.stderr.write(`Could not drain terminal input: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  };

  const dumpToScrollback = async (text: string): Promise<void> => {
    tui.stop({ preserveScreen: true });
    process.stdout.write(`${text.replace(/\r?\n/g, '\r\n')}\r\n\r\n── End of transcript: search or select it here. Press any key to return to Octipus. ──`);
    await new Promise<void>(done => {
      process.stdin.setRawMode?.(true);
      process.stdin.resume();
      process.stdin.once('data', () => done());
    });
    // The terminal records the raw state it finds at start and restores it on exit.
    process.stdin.setRawMode?.(false);
    process.stdout.write('\r\n');
    tui.start();
    tui.requestRender(true);
  };

  let exitHandler = (_signal: 'SIGINT' | 'SIGTERM') => { void shutdown().then(() => process.exit(0)); };
  process.on('SIGINT', () => exitHandler('SIGINT'));
  process.on('SIGTERM', () => exitHandler('SIGTERM'));
  return { tui, screen, mouse, gatewayUrl, keybindings, shutdown, copy, dumpToScrollback, search, attention, setExitHandler: handler => { exitHandler = handler; } };
}
