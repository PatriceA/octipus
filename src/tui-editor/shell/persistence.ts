/**
 * The editor's per-project checkpoint (`persist.ts`): restored at launch,
 * written 500 ms after the last change and once more at shutdown. A failed
 * checkpoint is reported in the mode bar until one succeeds.
 */
import { loadPersistedState, pathForProject, savePersistedState } from '../persist';
import { readFileForBuffer } from '../workspace-fs-bridge';
import type { EditorContext } from './context';
import type { FileOps } from './file-ops';

export class EditorPersistence {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly ctx: EditorContext,
    private readonly files: FileOps,
    /** Report whether the last checkpoint failed; returns whether that changed what is shown. */
    private readonly setFailed: (failed: boolean) => boolean,
  ) {}

  /** Restore layout, open files, cursors and drafts; then checkpoint on every change. Returns the unsubscribers. */
  hydrate(): Array<() => void> {
    const { layout, buffers } = this.ctx;
    const persisted = loadPersistedState(pathForProject(this.ctx.projectPath));
    if (persisted.treeVisible !== undefined && persisted.treeVisible !== layout.get().treeVisible) layout.toggleTree();
    if (persisted.chatVisible !== undefined && persisted.chatVisible !== layout.get().chatVisible) layout.toggleChat();
    if (persisted.editorMode) layout.setEditorMode(persisted.editorMode);
    if (persisted.softWrap) layout.setSoftWrap(true);
    for (const path of persisted.openPaths ?? []) {
      this.files.openFile(path, { activate: false });
      const cursor = persisted.cursorByPath?.[path];
      if (cursor) {
        const rec = buffers.findByPath(path);
        rec?.buffer.setCursor(cursor);
      }
    }
    if (persisted.activePath) {
      const rec = buffers.findByPath(persisted.activePath);
      if (rec) buffers.setActive(rec.id);
    }

    for (const draft of persisted.drafts ?? []) {
      // The draft goes over what is on disk now, so the buffer shows as unsaved against the file as it is.
      let rec = draft.path ? buffers.findByPath(draft.path) : null;
      if (draft.path && !rec) {
        const read = readFileForBuffer(draft.path);
        rec = buffers.openFile(draft.path, read.ok ? read.text : '', { disk: read.ok ? read.disk : null });
      }
      rec ??= buffers.openScratch();
      rec.buffer.setText(draft.text);
    }
    if (persisted.drafts?.length) this.ctx.pushMessage('system', `Recovered ${persisted.drafts.length} unsaved buffer(s). Review and save your edits.`);

    // Persist on every state change (debounced).
    const schedule = () => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.persist(), 500);
    };
    return [buffers.subscribe(schedule), layout.subscribe(schedule)];
  }

  persist(): void {
    const layout = this.ctx.layout.get();
    const buffers = this.ctx.buffers.get();
    const cursorByPath: Record<string, { line: number; col: number }> = {};
    for (const b of buffers.buffers) {
      if (!b.path) continue;
      const c = b.buffer.getCursor();
      cursorByPath[b.path] = { line: c.line, col: c.col };
    }
    const saved = savePersistedState({
      version: 1,
      openPaths: buffers.buffers.filter((b) => b.path).map((b) => b.path as string),
      activePath: buffers.buffers.find((b) => b.id === buffers.activeId)?.path ?? null,
      treeVisible: layout.treeVisible,
      chatVisible: layout.chatVisible,
      editorMode: layout.editorMode,
      softWrap: layout.softWrap,
      cursorByPath,
      drafts: buffers.buffers.filter(b => b.dirty).map(b => ({ path: b.path, text: b.buffer.text(), label: b.label })),
    }, pathForProject(this.ctx.projectPath));
    if (this.setFailed(!saved)) this.ctx.tui.requestRender();
  }

  /** Cancel the pending checkpoint and write one now (shutdown). */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.persist();
  }
}
