/**
 * Workspace + project root state.
 *
 * The TUI editor talks to the multi-user backend with an
 * `X-Octipus-Workspace` header. This store tracks which workspace
 * is active locally so the file tree, agent context, and status
 * bar all agree.
 */
export interface WorkspaceMeta {
  id: string;
  slug: string;
  name: string;
  isDefault: boolean;
}

export interface WorkspaceState {
  /** Available workspaces fetched from `/api/me/workspaces`. */
  available: readonly WorkspaceMeta[];
  /** Currently-selected workspace slug. NULL = backend's default. */
  activeSlug: string | null;
  /** Project root absolute path on the local filesystem. */
  projectRoot: string;
}

export type WorkspaceListener = (s: WorkspaceState) => void;

export class WorkspaceStore {
  private state: WorkspaceState = {
    available: [],
    activeSlug: null,
    projectRoot: process.cwd(),
  };
  private listeners = new Set<WorkspaceListener>();

  get(): WorkspaceState { return this.state; }

  subscribe(fn: WorkspaceListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<WorkspaceState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }

  setAvailable(ws: WorkspaceMeta[]): void { this.set({ available: ws }); }
  setActive(slug: string | null): void { this.set({ activeSlug: slug }); }
  setProjectRoot(p: string): void { this.set({ projectRoot: p }); }

  active(): WorkspaceMeta | null {
    if (!this.state.activeSlug) return this.state.available.find((w) => w.isDefault) ?? null;
    return this.state.available.find((w) => w.slug === this.state.activeSlug) ?? null;
  }
}
