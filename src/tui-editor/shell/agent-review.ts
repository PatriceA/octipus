/**
 * Review of the agent's file edits: an edit to an open buffer takes the
 * buffer's lock and is shown as a diff; accepting or rejecting it releases
 * the lock and presents the next queued edit.
 */
import { isAbsolute, resolve } from 'node:path';
import { DiffOverlay } from '../components/diff-overlay';
import type { EditorContext } from './context';
import type { FileOps } from './file-ops';

interface PendingEdit { bufferId: string; label: string; before: string; after: string }

export class AgentReview {
  private readonly queue: PendingEdit[] = [];

  constructor(private readonly ctx: EditorContext, private readonly files: FileOps) {}

  /** `agent.write`: the agent changed (or proposes to change) `path`. */
  handleWrite(path: string, newText: string): void {
    // The agent may name a file relative to the project it was given.
    const record = this.ctx.buffers.findByPath(isAbsolute(path) ? resolve(path) : resolve(this.ctx.projectPath, path));
    if (!record) {
      // Buffer isn't open — silently allow the write. Phase 7 may
      // open the file automatically and re-emit; for now skip.
      return;
    }
    // Lock the buffer until the user accepts or rejects; a queued diff holds its lock while it waits.
    this.ctx.buffers.setAgentLocked(record.id, true);
    this.open(record.id, record.label, record.buffer.text(), newText);
  }

  private open(bufferId: string, label: string, before: string, after: string): void {
    const { overlays, buffers, tui } = this.ctx;
    if (overlays.isOpen('diff')) { this.queue.push({ bufferId, label, before, after }); return; }
    buffers.setAgentLocked(bufferId, true);
    const overlay = new DiffOverlay({
      bufferLabel: label,
      before,
      after,
      onAccept: () => {
        const record = buffers.byId(bufferId);
        if (record) record.buffer.setText(after);
        buffers.setAgentLocked(bufferId, false);
        this.files.syncWithDisk(bufferId);
        this.ctx.log(`Accepted agent edit to ${label}.`);
        this.close();
        tui.requestRender();
      },
      onReject: () => {
        buffers.setAgentLocked(bufferId, false);
        const diskHasEdit = this.files.syncWithDisk(bufferId);
        this.ctx.log(diskHasEdit
          ? `Rejected agent edit to ${label}. The agent already wrote it to disk: the buffer keeps your text, unsaved — Ctrl+S writes it back over the agent's version.`
          : `Rejected agent edit to ${label}.`);
        this.close();
        tui.requestRender();
      },
    });
    overlays.show('diff', overlay);
  }

  private close(): void {
    if (!this.ctx.overlays.hide('diff')) return;
    const next = this.queue.shift();
    if (next) this.open(next.bufferId, next.label, this.ctx.buffers.get().buffers.find(b => b.id === next.bufferId)?.buffer.text() ?? next.before, next.after);
    else if (!this.ctx.tui.hasOverlay()) this.ctx.refocus();
  }
}
