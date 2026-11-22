/**
 * Review of the agent's file edits, hunk by hunk.
 *
 * An agent edit arrives while the user may be typing anywhere, so it never
 * opens on its own: it waits in `PendingPrompts`, the mode bar says an agent
 * edit is ready for review, and the review opens on the resolve key or when
 * the user saves that buffer. The active tab and the focus stay where they
 * are. A later edit to the same buffer replaces the waiting one (the agent's
 * newest text). An edit to a file that is not open opens it in a background
 * tab — compared with the file as it is on disk — rather than going by
 * unseen. While a review waits the file watcher leaves the buffer alone.
 *
 * The review is a diff of the buffer, as it is when the review opens,
 * against the agent's text; the buffer is locked while it is open. Applying
 * it puts the result (the accepted hunks, the rest as they were) in the
 * buffer as one undo step and releases the lock.
 *
 * The review controls the buffer, not the file: the agent may already have
 * written its version. After the review the buffer's baseline follows the
 * disk only when the disk holds exactly the agent's text, so `dirty` says
 * whether saving would change the file; a file changed by something else in
 * the meantime keeps its old baseline, and saving asks before overwriting it.
 */
import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { DiffOverlay, type ReviewResult } from '../components/diff-overlay';
import { readFileForBuffer } from '../workspace-fs-bridge';
import type { EditorContext } from './context';
import type { FileOps } from './file-ops';
import { reviewKey } from './pending-prompts';

interface PendingEdit { bufferId: string; after: string }

export class AgentReview {
  /** Edits waiting for the resolve key, by buffer: the agent's newest text for each. */
  private readonly waiting = new Map<string, PendingEdit>();
  /** The buffer whose review is open. */
  private reviewingId: string | null = null;

  constructor(private readonly ctx: EditorContext, private readonly files: FileOps) {}

  /** Whether an agent edit to `bufferId` is waiting for review or being reviewed. */
  underReview(bufferId: string): boolean { return this.reviewingId === bufferId || this.waiting.has(bufferId); }

  /** Forget the edits of buffers that closed. */
  prune(): void {
    for (const id of [...this.waiting.keys()]) if (!this.ctx.buffers.byId(id)) this.waiting.delete(id);
  }

  /** `agent.write`: the agent changed (or proposes to change) `path`. */
  handleWrite(path: string, newText: string): void {
    // The agent may name a file relative to the project it was given.
    const absolute = isAbsolute(path) ? resolve(path) : resolve(this.ctx.projectPath, path);
    // The buffer holds no CR of a CRLF pair; neither does the text it is compared with.
    const after = newText.replace(/\r\n/g, '\n');
    const record = this.ctx.buffers.findByPath(absolute) ?? this.openForReview(absolute);
    if (!record) return;
    this.wait({ bufferId: record.id, after });
  }

  /**
   * `agent.edit`: the agent replaces `oldText` with `newText` in `path`
   * (`str_replace_editor` str_replace, `edit` with `old_string`). The
   * replacement is made in the text the agent is working from — the edit
   * still waiting for review, else the open buffer, else the file — and the
   * whole result goes through the same review as a write. The old text must
   * occur exactly once: none or several is reported, never guessed at.
   */
  handleEdit(path: string, oldText: string, newText: string): void {
    const absolute = isAbsolute(path) ? resolve(path) : resolve(this.ctx.projectPath, path);
    const shown = relative(this.ctx.projectPath, absolute) || absolute;
    const fail = (why: string) => {
      this.ctx.notice(`Agent edit to ${shown} not shown: ${why}`);
      this.ctx.pushMessage('system', `Error: The agent's edit to ${shown} could not be reviewed: ${why}`);
    };
    const from = oldText.replace(/\r\n/g, '\n');
    const to = newText.replace(/\r\n/g, '\n');
    if (!from) { fail('it names no text to replace.'); return; }
    let record = this.ctx.buffers.findByPath(absolute);
    if (!record && !existsSync(absolute)) { fail('the file does not exist.'); return; }
    const base = record ? (this.waiting.get(record.id)?.after ?? record.buffer.text()) : null;
    let text = base;
    if (text === null) {
      const read = readFileForBuffer(absolute);
      if (!read.ok) { fail(read.error); return; }
      text = read.text;
    }
    const first = text.indexOf(from);
    if (first < 0) { fail('the text it replaces is not in the file.'); return; }
    if (text.indexOf(from, first + 1) >= 0) { fail('the text it replaces occurs more than once, so where it goes is ambiguous.'); return; }
    record ??= this.openForReview(absolute);
    if (!record) return;
    this.wait({ bufferId: record.id, after: text.slice(0, first) + to + text.slice(first + from.length) });
  }

  /** Hold an edit for the resolve key; nothing is opened over what the user is doing. */
  private wait(edit: PendingEdit): void {
    const id = edit.bufferId;
    this.waiting.set(id, edit);
    const label = this.ctx.buffers.byId(id)?.label ?? 'a file';
    this.ctx.pending.add({ key: reviewKey(id), bufferId: id, text: `agent edit to ${label} ready for review`, open: () => this.open(id) });
    this.ctx.tui.requestRender();
  }

  /** A file that is not open: open it in a tab to review the edit there. */
  private openForReview(absolute: string) {
    const { buffers } = this.ctx;
    const shown = relative(this.ctx.projectPath, absolute) || absolute;
    if (!existsSync(absolute)) {
      // A new file: compared with nothing. The tab has the path but no file yet; Ctrl+S creates it.
      const record = buffers.openFile(absolute, '', { disk: null, activate: false });
      this.ctx.log(`The agent is creating ${shown}; opened it for review.`);
      return record;
    }
    const read = readFileForBuffer(absolute);
    if (!read.ok) {
      this.ctx.pushMessage('system', `Error: The agent edited ${shown}, which cannot be opened for review: ${read.error}`);
      return null;
    }
    const record = buffers.openFile(absolute, read.text, { disk: read.disk, activate: false });
    this.ctx.log(`The agent edited ${shown}; opened it for review.`);
    return record;
  }

  /** Open the review of the edit waiting for `bufferId` (the resolve key, or saving that buffer). */
  private open(bufferId: string): void {
    const { overlays, buffers } = this.ctx;
    const edit = this.waiting.get(bufferId);
    const record = buffers.byId(bufferId);
    if (!edit || !record) { this.waiting.delete(bufferId); return; }
    if (overlays.isOpen('diff')) { this.wait(edit); return; }
    this.waiting.delete(bufferId);
    this.reviewingId = bufferId;
    buffers.setAgentLocked(bufferId, true);
    buffers.setActive(bufferId);
    overlays.show('diff', new DiffOverlay({
      bufferLabel: record.label,
      before: record.buffer.text(),
      after: edit.after,
      onApply: (result) => this.resolve(edit, record.label, result),
    }));
  }

  private resolve(edit: PendingEdit, label: string, result: ReviewResult): void {
    const { buffers, tui } = this.ctx;
    const record = buffers.byId(edit.bufferId);
    if (record && result.text !== record.buffer.text()) record.buffer.setText(result.text);
    buffers.setAgentLocked(edit.bufferId, false);
    this.reviewingId = null;
    const disk = this.files.syncWithDisk(edit.bufferId, edit.after);
    this.ctx.log(describe(label, result, disk));
    this.ctx.overlays.hide('diff');
    if (!tui.hasOverlay()) this.ctx.refocus();
    tui.requestRender();
  }
}

function describe(label: string, result: ReviewResult, disk: 'agent' | 'unchanged' | 'other'): string {
  const elsewhere = disk === 'other' ? ` ${label} also changed on disk outside this review: saving will ask before overwriting it.` : '';
  if (result.total === 0) return `The agent's edit to ${label} changes nothing in the buffer.${elsewhere}`;
  if (result.rejected === 0) return `Accepted agent edit to ${label}.${elsewhere}`;
  if (result.accepted === 0) {
    return disk === 'agent'
      ? `Rejected agent edit to ${label}. The agent already wrote it to disk: the buffer keeps your text, unsaved — Ctrl+S writes it back over the agent's version.`
      : `Rejected agent edit to ${label}.${elsewhere}`;
  }
  const part = `Applied ${result.accepted} of ${result.total} hunks of the agent edit to ${label}.`;
  return disk === 'agent'
    ? `${part} The agent already wrote its whole version to disk: Ctrl+S writes the reviewed version over it.`
    : `${part}${elsewhere}`;
}
