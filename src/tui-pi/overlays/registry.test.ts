import { expect, test, vi } from 'vitest';
import { type Component, CURSOR_MARKER, type Focusable, type TUI, visibleWidth } from '@mariozechner/pi-tui';
import { createOverlayController, FramedOverlay } from './registry';

function fakeTui() {
  const shown: Component[] = [];
  const tui = { showOverlay: (component: Component) => { shown.push(component); return { focus: vi.fn(), hide: vi.fn() }; } } as unknown as TUI;
  return { tui, shown };
}

/** An overlay that does not clean its own text, as an editor modal might. */
class CarelessModal implements Component, Focusable {
  focused = false;
  readonly input: string[] = [];
  render(): string[] {
    return [`tool said: a\nb\rc\td\x00e\x7f ${CURSOR_MARKER}`, '\x1b[31mred\x1b[0m', '世'.repeat(40)];
  }
  handleInput(data: string): void { this.input.push(data); }
  invalidate(): void {}
}

test('every overlay row is one terminal row no wider than the overlay', () => {
  const { tui, shown } = fakeTui();
  const modal = new CarelessModal();
  createOverlayController(tui).showModal(modal);
  const [rows] = shown.map(component => component.render(30));
  expect(rows).toHaveLength(3);
  for (const row of rows) {
    expect(row).not.toMatch(/[\n\r\t\x00\x7f]/);
    expect(visibleWidth(row)).toBeLessThanOrEqual(30);
  }
  // The app's own styling and the cursor marker survive.
  expect(rows[0]).toContain(CURSOR_MARKER);
  expect(rows[1]).toBe('\x1b[31mred\x1b[0m');
});

test('input and focus reach the wrapped component', () => {
  const { tui, shown } = fakeTui();
  const modal = new CarelessModal();
  createOverlayController(tui).showModal(modal);
  const framed = shown[0] as FramedOverlay;
  framed.handleInput('x');
  framed.focused = true;
  expect(modal.input).toEqual(['x']);
  expect(modal.focused).toBe(true);
  expect(framed.focused).toBe(true);
});

test('the chat prompts are framed too', () => {
  const { tui, shown } = fakeTui();
  const overlays = createOverlayController(tui);
  overlays.showApprovalPrompt({ summary: '', question: 'Go?', options: ['Yes'], onRespond: () => {} });
  overlays.showCommandPalette({ onCommand: () => {}, onCancel: () => {} });
  expect(shown.every(component => component instanceof FramedOverlay)).toBe(true);
});
