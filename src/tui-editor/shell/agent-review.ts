/**
 * Review of the agent's file edits, hunk by hunk.
 *
 * An edit to an open buffer takes the buffer's lock and is shown as a diff of
 * the buffer against the agent's text. An edit to a file that is not open
 * opens it in a tab first — a review tab, compared with the file as it is on
 * disk — rather than going by unseen. Applying the review puts the result
 * (the accepted hunks, the rest as they were) in the buffer as one undo
 * step, releases the lock and presents the next queued edit.
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

interface PendingEdit { bufferId: string; label: string; after: string }

export class AgentReview {
  private readonly queue: PendingEdit[] = [];

  constructor(private readonly ctx: EditorContext, private readonly files: FileOps) {}

  /** `agent.write`: the agent changed (or proposes to change) `path`. */
  handleWrite(path: string, newText: string): void {
    // The agent may name a file relative to the project it was given.
    const absolute = isAbsolute(path) ? resolve(path) : resolve(this.ctx.projectPath, path);
    // The buffer holds no CR of a CRLF pair; neither does the text it is compared with.
    const after = newText.replace(/\r\n/g, '\n');
    const record = this.ctx.buffers.findByPath(absolute) ?? this.openForReview(absolute);
    if (!record) return;
    // Lock the buffer until the review is applied; a queued edit holds its lock while it waits.
    this.ctx.buffers.setAgentLocked(record.id, true);
    this.open({ bufferId: record.id, label: record.label, after });
  }

  /** A file that is not open: open it in a tab to review the edit there. */
  private openForReview(absolute: string) {
    const { buffers } = this.ctx;
    const shown = relative(this.ctx.projectPath, absolute) || absolute;
    if (!existsSync(absolute)) {
      // A new file: compared with nothing. The tab has the path but no file yet; Ctrl+S creates it.
      const record = buffers.openFile(absolute, '', { disk: null });
      this.ctx.log(`The agent is creating ${shown}; opened it for review.`);
      return record;
    }
    const read = readFileForBuffer(absolute);
    if (!read.ok) {
      this.ctx.pushMessage('system', `Error: The agent edited ${shown}, which cannot be opened for review: ${read.error}`);
      return null;
    }
    const record = buffers.openFile(absolute, read.text, { disk: read.disk });
    this.ctx.log(`The agent edited ${shown}; opened it for review.`);
    return record;
  }

  private open(edit: PendingEdit): void {
    const { overlays, buffers } = this.ctx;
    if (overlays.isOpen('diff')) { this.queue.push(edit); return; }
    const record = buffers.byId(edit.bufferId);
    if (!record) { this.next(); return; }
    buffers.setAgentLocked(edit.bufferId, true);
    buffers.setActive(edit.bufferId);
    overlays.show('diff', new DiffOverlay({
      bufferLabel: edit.label,
      before: record.buffer.text(),
      after: edit.after,
      onApply: (result) => this.resolve(edit, result),
    }));
  }

  private resolve(edit: PendingEdit, result: ReviewResult): void {
    const { buffers, tui } = this.ctx;
    const record = buffers.byId(edit.bufferId);
    if (record && result.text !== record.buffer.text()) record.buffer.setText(result.text);
    buffers.setAgentLocked(edit.bufferId, false);
    const disk = this.files.syncWithDisk(edit.bufferId, edit.after);
    this.ctx.log(describe(edit.label, result, disk));
    this.ctx.overlays.hide('diff');
    this.next();
    tui.requestRender();
  }

  private next(): void {
    const next = this.queue.shift();
    if (next) this.open(next);
    else if (!this.ctx.tui.hasOverlay()) this.ctx.refocus();
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
