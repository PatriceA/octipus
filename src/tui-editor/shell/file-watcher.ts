/**
 * Notice when an open file changes on disk while it is open — another
 * editor, a formatter, `git checkout` — instead of only at the next save.
 *
 * Every second each open file's size and modification time are compared
 * with what the buffer last read or wrote (a stat per file; `fs.watch` loses
 * a file that is replaced by rename, which is how most editors and
 * formatters save). A changed file is then read, once, and compared with
 * the buffer's saved text, so a touch is not a change; the same read is the
 * reload.
 *
 * A buffer without unsaved edits is reloaded (one undo step brings the old
 * text back) and the mode bar says so. A buffer with unsaved edits is not
 * touched, and nothing is opened over what the user is typing: the reload /
 * overwrite / cancel prompt waits in `PendingPrompts` (the mode bar shows it)
 * until the resolve key or the next save of that buffer, once for that
 * version of the file. A deleted file is reported once. Buffers under agent
 * review, or with a review waiting, are left to the review. When the file
 * becomes the agent text the user rejected in a review (the agent's write
 * lands after its edit was reviewed), the buffer is not reloaded: the file
 * becomes its baseline and the user's text stays, unsaved, with a notice.
 */
import { statSync } from 'node:fs';
import { relative } from 'node:path';
import { readFileForBuffer } from '../workspace-fs-bridge';
import type { EditorContext } from './context';
import type { FileOps } from './file-ops';
import { externalKey } from './pending-prompts';

export const WATCH_INTERVAL_MS = 1000;

/** What the watcher asks the agent review (`AgentReview`). */
export interface WatchedReview {
  /** An agent edit to the buffer is waiting for review or being reviewed: leave it alone. */
  underReview(bufferId: string): boolean;
  /** Whether `diskText` is the agent text the user rejected (some hunks of) for this buffer; forgets it when it is. */
  takeRejected(bufferId: string, diskText: string): boolean;
}

export class FileWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** The file version (`mtime:size`) already offered or reported per buffer, so it is said once. */
  private readonly told = new Map<string, string>();

  constructor(
    private readonly ctx: EditorContext,
    private readonly files: FileOps,
    /** What the agent review knows about a buffer. */
    private readonly review: WatchedReview = { underReview: () => false, takeRejected: () => false },
  ) {}

  private inSync(id: string): void {
    this.told.delete(id);
    this.ctx.pending.remove(externalKey(id));
  }

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
      if (!record.path || !record.disk || record.agentLocked || this.review.underReview(record.id)) continue;
      let version: string;
      try {
        const stat = statSync(record.path);
        if (stat.mtimeMs === record.disk.mtimeMs && stat.size === record.disk.size) { this.inSync(record.id); continue; }
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
      // One read per changed file: it answers a touch, a catch-up, a rejected agent text and the reload.
      const now = readFileForBuffer(record.path);
      if (!now.ok) {
        this.told.set(record.id, version);
        this.ctx.notice(`${shown} changed on disk and cannot be read again: ${now.error}`);
        this.ctx.pushMessage('system', `Error: ${now.error}`);
        tui.requestRender();
        continue;
      }
      // A touch that left the content as it was.
      if (now.text === record.savedText) { this.inSync(record.id); buffers.markSaved(record.id, record.savedText, now.disk); continue; }
      // The disk now holds what the buffer holds (the agent wrote the text the review accepted): in sync.
      if (now.text === record.buffer.text()) { this.inSync(record.id); buffers.markSaved(record.id, now.text, now.disk); continue; }
      // The agent wrote the version the user rejected in review (agent.write arrives before the write itself):
      // reloading would undo the review. The file is the new baseline; the user's text stays, unsaved.
      if (this.review.takeRejected(record.id, now.text)) {
        this.inSync(record.id);
        buffers.markSaved(record.id, now.text, now.disk);
        this.ctx.notice(`The agent wrote its version of ${shown}, which you rejected: your version is kept, unsaved (Ctrl+S writes it back).`);
        tui.requestRender();
        continue;
      }
      if (!record.dirty) {
        this.files.reloadFromDisk(record.id, now);
        this.ctx.notice(`${shown} changed on disk and was reloaded (Ctrl+Z brings the old text back).`, 'info');
        tui.requestRender();
        continue;
      }
      // Unsaved edits: never a prompt over what is being typed (its r / o would take the next keys as an answer).
      // It waits for the resolve key or the next save of this buffer, once for this version.
      this.told.set(record.id, version);
      const id = record.id;
      this.ctx.pending.add({ key: externalKey(id), bufferId: id, text: `${shown} changed on disk`, open: () => { buffers.setActive(id); this.files.promptExternalChange(id, false); } });
      tui.requestRender();
    }
    // Forget buffers that closed.
    for (const id of [...this.told.keys()]) if (!buffers.byId(id)) this.told.delete(id);
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'ENOENT';
}
