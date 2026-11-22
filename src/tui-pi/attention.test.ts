import { describe, expect, test } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Attention, FOCUS_IN, FOCUS_OUT, notificationSequence, resolveNotifyMethod, titleFor } from './attention';
import { readNotifySetting, readSettingsFile } from './settings';

function terminal() {
  const written: string[] = [];
  const titles: string[] = [];
  const statuses: string[] = [];
  return { written, titles, statuses, write: (d: string) => written.push(d), setTitle: (t: string) => titles.push(t), setProgramStatus: (s: { state: string }) => statuses.push(s.state) };
}

describe('attention', () => {
  test('notifies only while the terminal is out of focus', () => {
    const t = terminal();
    const attention = new Attention(t, 'osc777');
    attention.notify('The reply is ready');
    expect(t.written).toEqual([]);
    expect(attention.observe(FOCUS_OUT)).toBe(true);
    attention.notify('The reply is ready');
    expect(t.written).toEqual(['\x1b]777;notify;Octipus;The reply is ready\x07']);
    attention.observe(FOCUS_IN);
    attention.notify('again');
    expect(t.written).toHaveLength(1);
    expect(attention.observe('x')).toBe(false);
  });

  test('every method, and off', () => {
    expect(notificationSequence('bell', 'Octipus', 'x')).toBe('\x07');
    expect(notificationSequence('osc9', 'Octipus', 'Reply ready')).toBe('\x1b]9;Octipus: Reply ready\x07');
    expect(notificationSequence('off', 'Octipus', 'x')).toBe('');
  });

  test('outside text cannot end the sequence or add fields', () => {
    const sequence = notificationSequence('osc777', 'Octipus', 'evil\x07\x1b]52;c;AAAA\x07;more;fields\n' + 'x'.repeat(500));
    expect(sequence.match(/\x07/g)).toHaveLength(1);
    expect(sequence.match(/\x1b/g)).toHaveLength(1);
    expect(sequence.split(';')).toHaveLength(4);
    expect(sequence.length).toBeLessThan(220);
  });

  test('auto picks what the terminal shows, and the bell inside a multiplexer', () => {
    expect(resolveNotifyMethod('auto', { TERM_PROGRAM: 'iTerm.app' })).toBe('osc9');
    expect(resolveNotifyMethod('auto', { WT_SESSION: '1' })).toBe('osc9');
    expect(resolveNotifyMethod('auto', { VTE_VERSION: '7600' })).toBe('osc777');
    expect(resolveNotifyMethod('auto', { VTE_VERSION: '7600', TMUX: '/tmp/x' })).toBe('bell');
    expect(resolveNotifyMethod('auto', {})).toBe('bell');
    expect(resolveNotifyMethod('osc9', { TMUX: '1' })).toBe('osc9');
  });

  test('the title follows the state, written only when it changes', () => {
    const t = terminal();
    const attention = new Attention(t, 'off');
    attention.setState('idle', 'repo');
    attention.setState('working', 'repo');
    attention.setState('working', 'repo');
    attention.setState('waiting', 'repo');
    expect(t.titles).toEqual(['Octipus — repo', 'Octipus — repo · working…', 'Octipus — repo · waiting for you']);
    expect(t.statuses).toEqual(['idle', 'working', 'blocked']);
    expect(titleFor('idle', 'a\x1b]0;b')).not.toContain('\x1b');
  });

  test('notify is read from tui.json and checked', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tui-notify-'));
    const path = join(dir, 'tui.json');
    writeFileSync(path, '{ "notify": "osc9" }');
    expect(readNotifySetting(path)).toBe('osc9');
    expect(readNotifySetting(join(dir, 'none.json'))).toBe('auto');
    writeFileSync(path, '{ "notify": "loud" }');
    expect(() => readSettingsFile(path)).toThrow(/notify: .*auto, bell, osc9, osc777, off/);
  });
});
