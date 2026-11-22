/**
 * Notice when an open file changes on disk while it is open — another
 * editor, a formatter, `git checkout` — instead of only at the next save.
 *
 * Every second each open file's size and modification time are compared
 * with what the buffer last read or wrote (a stat per file; `fs.watch` loses
 * a file that is replaced by rename, which is how most editors and
 * formatters save). A changed file is then read and compared with the
 * buffer's saved text, so a touch is not a change.
 *
 * A buffer without unsaved edits is reloaded (one undo step brings the old
 * text back) and the mode bar says so. A buffer with unsaved edits is not
 * touched: the reload / overwrite / cancel prompt is offered once for that
 * version of the file. A deleted file is reported once. Buffers under agent
 * review are left to the review.
 */
import { statSync } from 'node:fs';
import { relative } from 'node:path';
import { checkDisk, readFileForBuffer } from '../workspace-fs-bridge';
import type { EditorContext } from './context';
import type { FileOps } from './file-ops';

export const WATCH_INTERVAL_MS = 1000;

export class FileWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** The file version (`mtime:size`) already offered or reported per buffer, so it is said once. */
  private readonly told = new Map<string, string>();

  constructor(private readonly ctx: EditorContext, private readonly files: FileOps) {}

  start(interval = WATCH_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.check(), interval);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass over the open files. */
  check(): void {
    const { buffers, tui } = this.ctx;
    for (const record of buffers.get().buffers) {
      if (!record.path || !record.disk || record.agentLocked) continue;
      let version: string;
      try {
        const stat = statSync(record.path);
        if (stat.mtimeMs === record.disk.mtimeMs && stat.size === record.disk.size) { this.told.delete(record.id); continue; }
        version = `${stat.mtimeMs}:${stat.size}`;
      } catch (error) {
        if (!isMissing(error)) { this.ctx.pushMessage('system', `Error: Cannot check ${record.path}: ${error instanceof Error ? error.message : String(error)}`); continue; }
        version = 'deleted';
      }
      if (this.told.get(record.id) === version) continue;
      const shown = relative(this.ctx.projectPath, record.path) || record.path;
      if (version === 'deleted') {
        this.told.set(record.id, version);
        this.ctx.notice(`${shown} was deleted on disk; the buffer keeps its text (Ctrl+S writes it again).`);
        tui.requestRender();
        continue;
      }
      let check: ReturnType<typeof checkDisk>;
      try {
        check = checkDisk(record.path, record.disk, record.savedText);
      } catch (error) {
        this.told.set(record.id, version);
        this.ctx.pushMessage('system', `Error: Cannot check ${record.path}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (!check.changed) { buffers.markSaved(record.id, record.savedText, check.disk); continue; }
      // The disk now holds what the buffer holds (the agent wrote the text the review accepted): in sync.
      const now = readFileForBuffer(record.path);
      if (now.ok && now.text === record.buffer.text()) { buffers.markSaved(record.id, now.text, now.disk); continue; }
      if (!record.dirty) {
        this.files.reloadFromDisk(record.id);
        this.ctx.notice(`${shown} changed on disk and was reloaded (Ctrl+Z brings the old text back).`, 'info');
        tui.requestRender();
        continue;
      }
      // Unsaved edits: ask, once for this version, when nothing else is being asked.
      if (tui.hasOverlay()) continue;
      this.told.set(record.id, version);
      buffers.setActive(record.id);
      this.files.promptExternalChange(record.id, false);
      tui.requestRender();
    }
    // Forget buffers that closed.
    for (const id of [...this.told.keys()]) if (!buffers.byId(id)) this.told.delete(id);
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'ENOENT';
}
