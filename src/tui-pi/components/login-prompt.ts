/**
 * Sign-in overlay: username, password, and a TOTP field that only appears
 * once the server asks for one.
 *
 * Deliberately not a chat command with arguments — `/login alice hunter2`
 * would put the password in the transcript, the scrollback and the terminal's
 * own history. Typed here, the password is masked and never rendered.
 */
import { type Component, type Focusable, matchesKey, truncateToWidth, visibleWidth } from '@mariozechner/pi-tui';
import { chalk, getPalette } from '../theme/defaults';

export interface LoginPromptOptions {
  /** Pre-fill the username (e.g. the last account that signed in here). */
  username?: string;
  /** Called with the collected credentials. Resolve `false` to keep the box open. */
  onSubmit: (credentials: { username: string; password: string; totpCode?: string }) => void;
  onCancel: () => void;
}

type Field = 'username' | 'password' | 'totp';

export class LoginPrompt implements Component, Focusable {
  focused = false;

  private username: string;
  private password = '';
  private totp = '';
  private field: Field = 'username';
  private totpRequired = false;
  private status: string | null = null;
  private busy = false;

  constructor(private readonly options: LoginPromptOptions) {
    this.username = options.username ?? '';
    if (this.username) this.field = 'password';
  }

  invalidate(): void { /* no cached state */ }

  /** Show an error from the server and re-enable input. */
  setError(message: string, opts?: { totpRequired?: boolean }): void {
    this.status = message;
    this.busy = false;
    if (opts?.totpRequired) {
      this.totpRequired = true;
      this.field = 'totp';
    }
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      this.options.onCancel();
      return;
    }
    if (this.busy) return;

    if (matchesKey(data, 'tab') || matchesKey(data, 'down')) {
      this.field = this.nextField(1);
      return;
    }
    if (matchesKey(data, 'shift+tab') || matchesKey(data, 'up')) {
      this.field = this.nextField(-1);
      return;
    }
    if (matchesKey(data, 'enter')) {
      // Enter advances until the last field, then submits — the usual login
      // form behaviour, so a fast typist never has to reach for Tab.
      if (this.field !== this.lastField()) {
        this.field = this.nextField(1);
        return;
      }
      this.submit();
      return;
    }
    if (matchesKey(data, 'backspace')) {
      this.edit((value) => value.slice(0, -1));
      return;
    }

    // Printable characters only: control sequences (arrows, function keys)
    // arrive as escape-prefixed strings and must not land in a field.
    if (data.startsWith('\x1b') || data.length === 0) return;
    const printable = [...data].filter((ch) => ch >= ' ' && ch !== '\x7f').join('');
    if (printable) this.edit((value) => value + printable);
  }

  private submit(): void {
    if (!this.username.trim() || !this.password) {
      this.status = 'Username and password are required.';
      return;
    }
    this.busy = true;
    this.status = 'Signing in…';
    this.options.onSubmit({
      username: this.username.trim(),
      password: this.password,
      totpCode: this.totp.trim() || undefined,
    });
  }

  private edit(fn: (value: string) => string): void {
    if (this.field === 'username') this.username = fn(this.username);
    else if (this.field === 'password') this.password = fn(this.password);
    else this.totp = fn(this.totp);
  }

  private fields(): Field[] {
    return this.totpRequired ? ['username', 'password', 'totp'] : ['username', 'password'];
  }

  private lastField(): Field {
    const fields = this.fields();
    return fields[fields.length - 1];
  }

  private nextField(step: 1 | -1): Field {
    const fields = this.fields();
    const index = fields.indexOf(this.field);
    return fields[(index + step + fields.length) % fields.length];
  }

  render(width: number): string[] {
    const palette = getPalette();
    const border = (text: string) => chalk.hex(palette.accent)(text);
    const dim = (text: string) => chalk.hex(palette.dim)(text);

    const rows = [
      chalk.bold.hex(palette.accent)('Sign in to Octipus'),
      dim('Your account — memories, vault secrets and settings.'),
      '',
      this.fieldLine('user', this.username, 'username'),
      this.fieldLine('pass', '•'.repeat(this.password.length), 'password'),
      ...(this.totpRequired ? [this.fieldLine('totp', this.totp, 'totp')] : []),
      '',
      this.status
        ? chalk.hex(this.busy ? palette.statusFg : palette.error)(this.status)
        : dim('Tab/↑↓ switch · Enter submit · Esc cancel'),
    ];

    const maxInner = Math.max(1, width - 4);
    const innerWidth = Math.min(maxInner, Math.max(...rows.map((row) => visibleWidth(row)), 34));
    const boxWidth = innerWidth + 4;
    const line = (text: string) =>
      border('│ ') + padTo(truncateToWidth(text, innerWidth), innerWidth) + border(' │');

    return [
      border('┌' + '─'.repeat(boxWidth - 2) + '┐'),
      ...rows.map(line),
      border('└' + '─'.repeat(boxWidth - 2) + '┘'),
    ];
  }

  private fieldLine(label: string, value: string, field: Field): string {
    const palette = getPalette();
    const active = this.field === field;
    const marker = active ? chalk.hex(palette.accent)('›') : ' ';
    const caret = active && !this.busy ? chalk.hex(palette.accent)('▌') : '';
    return `${marker} ${chalk.hex(palette.dim)(label.padEnd(5))}${value}${caret}`;
  }
}

function padTo(text: string, width: number): string {
  const pad = width - visibleWidth(text);
  return pad > 0 ? text + ' '.repeat(pad) : text;
}
