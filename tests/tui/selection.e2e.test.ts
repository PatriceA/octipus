import { afterEach, describe, expect, test } from 'vitest';
import { TuiHarness, KEY } from './harness';
let tui: TuiHarness | undefined;
afterEach(async () => { await tui?.stop(); tui = undefined; });

describe.skipIf(process.platform === 'win32')('terminal selection and copy', () => {
  test.each(['src/tui-pi/index.ts', 'src/tui-editor/index.ts'])('%s keeps wheel scrolling, copy, and keyboard history available without toggling', async entry => {
    tui = await TuiHarness.start(entry, 100, 28);
    await tui.waitFor('connected');
    if (entry.includes('tui-editor')) { tui.send(KEY.CtrlBackslash); await tui.waitFor('focus:chat'); }
    const response = Array.from({ length: 80 }, (_, n) => `Copy line ${n}`).join('\n');
    tui.event('chat.response', { response }); await tui.waitFor('Copy line 79');
    expect(tui.screen.modes.mouseTrackingMode).toBe('vt200');
    expect(await tui.text()).not.toContain('[wheel captured');
    tui.send('\x1b[<64;10;5M'); await tui.waitFor('End: latest');
    tui.send('\x1b[1;5F'); // Ctrl+End before the clipboard request.

    tui.send('/copy last\r'); await tui.waitFor('Clipboard request sent');
    expect(Buffer.from(tui.clipboardRequests.at(-1)!.slice(2), 'base64').toString()).toBe(response);
    expect(tui.commands.some(command => command.name === 'copy' || command.name === 'mouse')).toBe(false);
    tui.send('unsent selection draft'); await tui.waitFor('unsent selection draft');
    tui.send('\x1b[1;5H'); await tui.waitFor('Copy line 0');
    expect(await tui.text()).toContain('unsent selection draft');
    expect(tui.screen.modes.mouseTrackingMode).toBe('vt200');
    tui.resize(85, 24); await tui.waitFor('Copy line 0');
    await tui.waitFor('unsent selection draft');
    expect(tui.screen.modes.mouseTrackingMode).toBe('vt200');
    expect(await tui.text()).toContain('unsent selection draft');
    expect(tui.commands.some(command => command.type === 'chat.send')).toBe(false);
  });
});
