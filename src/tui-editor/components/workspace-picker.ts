/**
 * Workspace picker overlay.
 *
 * Reads available workspaces from the WorkspaceStore (populated by
 * `apiClient.getJson('/me/workspaces')` at app start). Selecting a
 * workspace stores the new active slug; the parent app reconnects
 * the gateway so the next session picks up the workspace context.
 *
 * Renders nothing meaningful when no workspaces are loaded yet —
 * single-tenant installs see a placeholder line and Esc closes.
 */
import {
  type Component,
  displayLine,
  type Focusable,
  matchesKey,
  type SelectItem,
  SelectList,
} from '@/tui-kit';
import { drawBox, fitBoxWidth } from '@/tui-kit/overlay-frame';
import type { WorkspaceMeta, WorkspaceStore } from '../stores/workspace-store';
import { chalk, getPalette, getSelectListTheme } from '@/tui-pi/theme/defaults';

export interface WorkspacePickerOptions {
  workspaces: WorkspaceStore;
  onPick: (slug: string | null) => void;
  onCancel: () => void;
  /** Why the list could not be refreshed; shown above the list (or instead of it). */
  error?: string;
}

export class WorkspacePicker implements Component, Focusable {
  focused = false;
  private readonly list: SelectList | null;

  constructor(private readonly options: WorkspacePickerOptions) {
    const items = makeItems(options.workspaces.get().available);
    if (items.length === 0) {
      this.list = null;
      return;
    }
    this.list = new SelectList(items, 8, getSelectListTheme());
    this.list.onSelect = (item) => this.options.onPick(item.value || null);
    this.list.onCancel = () => this.options.onCancel();
  }

  invalidate(): void { this.list?.invalidate(); }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape')) { this.options.onCancel(); return; }
    this.list?.handleInput(data);
  }

  render(width: number): string[] {
    const palette = getPalette();
    const border = (text: string) => chalk.hex(palette.border)(text);
    const dim = (text: string) => chalk.hex(palette.dim)(text);
    const accent = (text: string) => chalk.hex(palette.accent)(text);

    const header = accent('Switch workspace');
    const help = dim('Enter switch · Esc cancel');

    const error = this.options.error ? [chalk.hex(palette.error)(`Could not load workspaces: ${displayLine(this.options.error)}`)] : [];
    const bodyLines = [...error, ...(this.list
      ? this.list.render(width - 4)
      : [dim(this.options.error ? 'No workspaces to choose from.' : 'No workspaces loaded — single-tenant install.')])];

    const body = [header, ...bodyLines, help];
    return drawBox([body], fitBoxWidth(body, width), border);
  }
}

function makeItems(workspaces: readonly WorkspaceMeta[]): SelectItem[] {
  return workspaces.map((w) => ({
    value: w.slug,
    label: w.name,
    description: `${w.slug}${w.isDefault ? ' · default' : ''}`,
  }));
}
