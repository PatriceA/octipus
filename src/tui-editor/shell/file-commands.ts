/**
 * Creating, renaming, deleting and reverting files: `/new-file`, `/rename`,
 * `/delete`, `/revert`, Alt+N, and the tree's n / m / d keys.
 *
 * Paths are typed relative to the project (or absolute). Nothing is
 * replaced: a new file or a new name that is already taken is refused, and
 * so is a folder that does not exist. A delete asks first and says when the
 * buffer has unsaved changes; only files are deleted, never folders. A
 * rename takes the open buffers with it (a renamed folder, every buffer
 * under it), unsaved edits included.
 */
import { existsSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { ConfirmPrompt } from '../components/confirm-prompt';
import { InputPrompt } from '../components/input-prompt';
import { type DiskInfo, writeFileForBuffer } from '../workspace-fs-bridge';
import type { EditorContext } from './context';
import { type FileOps, PROMPT_OVERLAY } from './file-ops';
import { APP_OVERLAYS } from './overlay-slots';

export class FileCommands {
  constructor(
    private readonly ctx: EditorContext,
    private readonly files: FileOps,
    /** The folder listing changed: the tree reads it again. */
    private readonly onTreeChanged: () => void,
    /** A buffer was given a new path: its highlighting is parsed again. */
    private readonly onRebound: (id: string) => void,
  ) {}

  private shown(path: string): string { return relative(this.ctx.projectPath, path) || path; }

  /** Ask a one-field question; `answer` returns an error to show, or null when done. */
  private ask(title: string, initial: string, hint: string, answer: (value: string) => string | null): void {
    const { overlays, tui } = this.ctx;
    if (overlays.isOpen('prompt')) return;
    overlays.hideAll(APP_OVERLAYS);
    const prompt = new InputPrompt({
      title, label: 'path: ', hint, initial,
      onCancel: () => overlays.close('prompt'),
      onSubmit: (value) => {
        const error = answer(value);
        if (error) { prompt.setError(error); tui.requestRender(); return; }
        overlays.close('prompt');
        tui.requestRender();
      },
    });
    overlays.show('prompt', prompt, PROMPT_OVERLAY);
  }

  /** Report an error from a command typed in full (no prompt to show it in). */
  private report(error: string | null): void {
    if (error) this.ctx.pushMessage('system', `Error: ${error}`);
  }

  /** `/new-file [path]`, Alt+N, the tree's n: create an empty file and open it. `folder` prefills the prompt. */
  newFile(input: string, folder?: string): void {
    if (input) { this.report(this.create(input)); return; }
    const active = this.ctx.buffers.active();
    const base = folder ?? (active?.path ? dirname(active.path) : this.ctx.projectPath);
    const prefill = relative(this.ctx.projectPath, base);
    this.ask('New file', prefill ? `${prefill}${sep}` : '', 'Relative to the project, or absolute · Enter create · Esc cancel', (value) => this.create(value));
  }

  private create(input: string): string | null {
    if (!input) return 'Type a path for the new file.';
    const target = resolve(this.ctx.projectPath, input);
    if (existsSync(target)) return `${this.shown(target)} already exists.`;
    if (!existsSync(dirname(target))) return `The folder ${this.shown(dirname(target))} does not exist.`;
    const written = writeFileForBuffer(target, '', null);
    if (!written.ok) return written.error;
    this.onTreeChanged();
    this.files.openFile(target);
    this.ctx.layout.focus('editor');
    this.ctx.refocus();
    this.ctx.notice(`Created ${this.shown(target)}.`, 'info');
    return null;
  }

  /** `/rename [path]`, the tree's m: give a file or folder a new name. `path` defaults to the active buffer's file. */
  rename(input: string, path?: string): void {
    const from = path ?? this.ctx.buffers.active()?.path ?? null;
    if (!from) { this.report('No file to rename: open one, or choose one in the tree.'); return; }
    if (input) { this.report(this.move(from, input)); return; }
    this.ask(`Rename ${this.shown(from)}`, this.shown(from), 'The new path, relative to the project · Enter rename · Esc cancel', (value) => this.move(from, value));
  }

  private move(from: string, input: string): string | null {
    if (!input) return 'Type the new path.';
    const target = resolve(this.ctx.projectPath, input);
    if (target === from) return null;
    if (!existsSync(from)) return `${this.shown(from)} is not on disk.`;
    if (existsSync(target)) return `${this.shown(target)} already exists.`;
    if (!existsSync(dirname(target))) return `The folder ${this.shown(dirname(target))} does not exist.`;
    try {
      renameSync(from, target);
    } catch (error) {
      return `Cannot rename ${this.shown(from)}: ${error instanceof Error ? error.message : String(error)}`;
    }
    // The open buffers follow: the file itself, or everything under a renamed folder.
    const { buffers } = this.ctx;
    for (const record of buffers.get().buffers) {
      if (!record.path) continue;
      const moved = record.path === from ? target : record.path.startsWith(from + sep) ? target + record.path.slice(from.length) : null;
      if (!moved) continue;
      buffers.rebind(record.id, moved, record.savedText, record.disk ?? diskOf(moved));
      this.onRebound(record.id);
    }
    this.onTreeChanged();
    this.ctx.notice(`Renamed ${this.shown(from)} to ${this.shown(target)}.`, 'info');
    return null;
  }

  /** `/delete`, the tree's d: delete a file after asking. `path` defaults to the active buffer's file. */
  delete(path?: string): void {
    const { overlays, buffers, tui } = this.ctx;
    const target = path ?? buffers.active()?.path ?? null;
    if (!target) { this.report('No file to delete: open one, or choose one in the tree.'); return; }
    if (!existsSync(target)) { this.report(`${this.shown(target)} is not on disk.`); return; }
    if (statSync(target).isDirectory()) { this.report(`${this.shown(target)} is a folder; the editor deletes files only.`); return; }
    if (overlays.isOpen('prompt')) return;
    overlays.hideAll(APP_OVERLAYS);
    const record = buffers.findByPath(target);
    const detail = record?.dirty
      ? `${this.shown(target)} will be removed from disk, and its tab with its unsaved changes closed. This cannot be undone.`
      : `${this.shown(target)} will be removed from disk${record ? ' and its tab closed' : ''}. This cannot be undone.`;
    overlays.show('prompt', new ConfirmPrompt(`Delete ${this.shown(target)}?`, detail, 'Delete', (confirmed) => {
      overlays.close('prompt');
      if (confirmed) this.report(this.remove(target));
      tui.requestRender();
    }), PROMPT_OVERLAY);
  }

  private remove(target: string): string | null {
    try {
      unlinkSync(target);
    } catch (error) {
      return `Cannot delete ${this.shown(target)}: ${error instanceof Error ? error.message : String(error)}`;
    }
    const record = this.ctx.buffers.findByPath(target);
    if (record) this.ctx.buffers.close(record.id);
    this.onTreeChanged();
    this.ctx.notice(`Deleted ${this.shown(target)}.`, 'info');
    return null;
  }

  /** `/revert`: the active buffer back to the file on disk, as one undo step. */
  revert(): void {
    const active = this.ctx.buffers.active();
    if (!active?.path) { this.report('No file to reload: the active buffer has none.'); return; }
    this.files.reloadFromDisk(active.id);
    this.ctx.tui.requestRender();
  }
}

/** What a file on disk is now, for a buffer that had no record of it. */
function diskOf(path: string): DiskInfo {
  const stat = statSync(path);
  return { mtimeMs: stat.mtimeMs, size: stat.size, eol: '\n', bom: false, mode: stat.mode & 0o7777 };
}
