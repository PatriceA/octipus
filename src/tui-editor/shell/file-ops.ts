/**
 * Opening, saving and reloading files, and the questions that go with them:
 * Save As, "changed on disk", "unsaved changes".
 *
 * Nothing here writes a file without the check the editor promises: a file
 * changed on disk since it was read is not overwritten without asking, and a
 * buffer that never read its path does not replace a file that is there.
 */
import { existsSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { getKeybindings, type OverlayOptions } from '@/tui-kit';
import { ExternalChangePrompt } from '../components/external-change-prompt';
import { SaveAsPrompt } from '../components/save-as-prompt';
import { UnsavedPrompt } from '../components/unsaved-prompt';
import { checkDisk, readFileForBuffer, writeFileForBuffer } from '../workspace-fs-bridge';
import type { EditorContext } from './context';

/** Small questions (Save As, file changed on disk) sit low, like the other prompts. */
export const PROMPT_OVERLAY: OverlayOptions = { anchor: 'bottom-center', width: '60%', minWidth: 40, margin: { bottom: 2, left: 2, right: 2 } };

export type WriteOutcome = { ok: true } | { ok: false; needs: 'path' | 'confirm'; deleted?: boolean } | { ok: false; error: string };

export class FileOps {
  constructor(
    private readonly ctx: EditorContext,
    /** A buffer was given a new file (Save As): its highlighting is parsed again. */
    private readonly onRebound: (id: string) => void,
  ) {}

  openFile(absolutePath: string, options: { activate?: boolean } = {}): void {
    const { buffers } = this.ctx;
    const open = buffers.findByPath(absolutePath);
    if (open) { if (options.activate !== false) buffers.setActive(open.id); return; }
    const read = readFileForBuffer(absolutePath);
    if (!read.ok) { this.ctx.notice(read.error); this.ctx.pushMessage('system', `Error: ${read.error}`); return; }
    const record = buffers.openFile(absolutePath, read.text, { disk: read.disk });
    if (options.activate !== false) buffers.setActive(record.id);
    if (read.mixedEol) {
      this.ctx.pushMessage('system', `${record.label} mixes CRLF and LF line endings; saving writes ${read.disk.eol === '\r\n' ? 'CRLF' : 'LF'} throughout.`);
    }
  }

  /**
   * Write a buffer to its file, unless the file changed on disk since it was
   * read or saved (`overwrite` skips that check). Never asks anything; the
   * outcome says what is needed.
   */
  writeBuffer(id: string, overwrite = false): WriteOutcome {
    const { buffers } = this.ctx;
    const record = buffers.byId(id);
    if (!record) return { ok: false, error: 'The buffer is no longer open.' };
    if (!record.path) return { ok: false, needs: 'path' };
    if (!overwrite) {
      if (record.disk) {
        let check: ReturnType<typeof checkDisk>;
        try {
          check = checkDisk(record.path, record.disk, record.savedText);
        } catch (error) {
          return { ok: false, error: `Cannot check ${record.path} before saving: ${error instanceof Error ? error.message : String(error)}` };
        }
        if (check.changed) return { ok: false, needs: 'confirm', deleted: check.deleted };
        if (check.disk !== record.disk) buffers.markSaved(id, record.savedText, check.disk);
      } else if (existsSync(record.path)) {
        // Never read from this path (a recovered draft, a path chosen elsewhere): writing would replace a file the buffer never saw.
        return { ok: false, needs: 'confirm', deleted: false };
      }
    }
    const text = record.buffer.text();
    const result = writeFileForBuffer(record.path, text, record.disk);
    if (!result.ok) return { ok: false, error: result.error };
    buffers.markSaved(id, text, result.disk);
    return { ok: true };
  }

  /** Ctrl+S, `:w`: save, asking for a path (scratch) or a decision (changed on disk) when needed. */
  saveBuffer(id: string, overwrite = false): boolean {
    const outcome = this.writeBuffer(id, overwrite);
    const record = this.ctx.buffers.byId(id);
    if (outcome.ok) {
      this.ctx.notice(`Saved ${record?.label ?? ''}.`, 'info');
      this.ctx.pushMessage('system', `Saved ${record?.path ?? ''}.`);
      return true;
    }
    if ('error' in outcome) {
      this.ctx.notice(`Save failed: ${outcome.error} Edits retained.`);
      this.ctx.pushMessage('system', `Error: ${outcome.error} Your edits are still in memory.`);
      return false;
    }
    if (outcome.needs === 'path') this.openSaveAs(id);
    else this.promptExternalChange(id, outcome.deleted === true);
    return false;
  }

  /** Saving would overwrite a file that changed on disk: reload, overwrite or cancel. */
  promptExternalChange(id: string, deleted: boolean): void {
    const { overlays, tui } = this.ctx;
    const record = this.ctx.buffers.byId(id);
    if (!record?.path || overlays.isOpen('external')) return;
    const prompt = new ExternalChangePrompt(record.label, deleted, (choice) => {
      overlays.hide('external');
      if (choice === 'overwrite') this.saveBuffer(id, true);
      if (choice === 'reload') this.reloadFromDisk(id);
      if (!tui.hasOverlay()) this.ctx.refocus();
      tui.requestRender();
    });
    overlays.show('external', prompt, PROMPT_OVERLAY);
  }

  /** Replace the buffer with the file on disk, as one undoable step. */
  reloadFromDisk(id: string): void {
    const record = this.ctx.buffers.byId(id);
    if (!record?.path) return;
    const read = readFileForBuffer(record.path);
    if (!read.ok) { this.ctx.notice(read.error); this.ctx.pushMessage('system', `Error: ${read.error}`); return; }
    record.buffer.setText(read.text);
    this.ctx.buffers.markSaved(id, read.text, read.disk);
    this.ctx.notice(`Reloaded ${record.label} from disk (Ctrl+Z brings your version back).`, 'info');
  }

  /** Save As, for scratch buffers and for saving a file under a new name. */
  openSaveAs(id: string): void {
    const { overlays, tui } = this.ctx;
    const record = this.ctx.buffers.byId(id);
    if (!record || overlays.isOpen('saveAs')) return;
    const initial = record.path ? relative(this.ctx.projectPath, record.path) : '';
    let confirmOverwrite: string | null = null;
    const prompt = new SaveAsPrompt({
      label: record.label,
      initial,
      onCancel: () => this.closeSaveAs(),
      onSubmit: (input) => {
        const result = this.saveAs(id, input, confirmOverwrite);
        if (result === 'saved') { this.closeSaveAs(); return; }
        if (result.confirm) confirmOverwrite = result.confirm;
        prompt.setError(result.error);
        tui.requestRender();
      },
    });
    overlays.show('saveAs', prompt, PROMPT_OVERLAY);
  }

  private closeSaveAs(): void {
    if (this.ctx.overlays.close('saveAs')) this.ctx.tui.requestRender();
  }

  /**
   * Write buffer `id` to `input` (relative to the project, or absolute) and
   * make that its file. An existing file is only replaced when the same path
   * was already confirmed (`confirmed`).
   */
  saveAs(id: string, input: string, confirmed: string | null): 'saved' | { error: string; confirm?: string } {
    const { buffers, projectPath } = this.ctx;
    const record = buffers.byId(id);
    if (!record) return { error: 'The buffer is no longer open.' };
    if (!input) return { error: 'Type a path for the file.' };
    const target = resolve(projectPath, input);
    const other = buffers.findByPath(target);
    if (other && other.id !== id) return { error: `${input} is open in another tab; close it first.` };
    if (!existsSync(dirname(target))) return { error: `The folder ${relative(projectPath, dirname(target)) || dirname(target)} does not exist.` };
    if (existsSync(target)) {
      if (statSync(target).isDirectory()) return { error: `${input} is a folder.` };
      if (target !== record.path && confirmed !== target) return { error: `${input} already exists. Press Enter again to replace it.`, confirm: target };
    }
    const existing = target === record.path ? record.disk : null;
    const text = record.buffer.text();
    const result = writeFileForBuffer(target, text, existing);
    if (!result.ok) return { error: result.error };
    buffers.rebind(id, target, text, result.disk);
    this.onRebound(id);
    this.ctx.notice(`Saved as ${relative(projectPath, target) || target}.`, 'info');
    this.ctx.pushMessage('system', `Saved ${target}.`);
    return 'saved';
  }

  /** Ask about the dirty buffers among `ids` (save, discard, cancel); `proceed` runs unless cancelled. */
  confirmUnsaved(ids: string[], proceed: () => void): void {
    const { overlays, tui, buffers } = this.ctx;
    if (overlays.isOpen('unsaved')) return;
    const dirty = buffers.get().buffers.filter(b => ids.includes(b.id) && b.dirty);
    if (!dirty.length) { proceed(); return; }
    const prompt = new UnsavedPrompt(dirty.map(b => b.label), choice => {
      if (choice === 'save') {
        for (const id of ids) {
          const current = buffers.byId(id);
          if (!current?.dirty) continue;
          const outcome = this.writeBuffer(id);
          if (outcome.ok) continue;
          const why = 'error' in outcome ? `Save failed: ${outcome.error}`
            : outcome.needs === 'path' ? `${current.label} has no file yet: cancel, then Save As (${getKeybindings().getKeys('app.file.saveAs')[0] ?? '/save-as'}).`
            : `${current.label} changed on disk since you opened it: cancel, then Ctrl+S to reload or overwrite.`;
          prompt.setError(`${why} Edits retained.`); tui.requestRender(); return;
        }
      }
      if (choice === 'discard') for (const id of ids) buffers.revert(id);
      overlays.hide('unsaved');
      if (choice !== 'cancel') proceed();
      if (!tui.hasOverlay()) this.ctx.refocus();
    });
    overlays.show('unsaved', prompt);
  }

  /**
   * Take the file's current content as the buffer's saved text if it changed
   * on disk (the agent wrote it), so `dirty` says whether the buffer matches
   * the disk. Returns whether the disk changed.
   */
  syncWithDisk(bufferId: string): boolean {
    const record = this.ctx.buffers.byId(bufferId);
    if (!record?.path || !record.disk) return false;
    let check: ReturnType<typeof checkDisk>;
    try {
      check = checkDisk(record.path, record.disk, record.savedText);
    } catch (error) {
      this.ctx.pushMessage('system', `Error: Cannot check ${record.path}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    if (!check.changed || check.deleted) return false;
    const read = readFileForBuffer(record.path);
    if (!read.ok) return false;
    this.ctx.buffers.markSaved(bufferId, read.text, read.disk);
    return true;
  }
}
