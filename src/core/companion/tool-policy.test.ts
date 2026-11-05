import { expect, test } from 'vitest';
import { companionControllerTools } from './tool-policy';
test('observation and disabled supervision withhold all project mutations', () => {
  for (const tools of [companionControllerTools('observe', true, false), companionControllerTools('repair', false, true)]) {
    expect(tools.has('companion__inspect_session')).toBe(true);
    expect(tools.has('companion__start_session')).toBe(false);
    expect(tools.has('companion__update')).toBe(false);
  }
});
test('controllers have no generic shell, file writer or child-delegation escape path', () => {
  const tools = companionControllerTools('repair', true, false);
  for (const name of ['shell__run', 'filesystem__write_file', 'spawn_child', 'create_pipeline', 'call_discovered_tool']) expect(tools.has(name)).toBe(false);
  expect(tools.has('companion__message_session')).toBe(true);
  expect(tools.has('companion__create')).toBe(false);
  expect(companionControllerTools('coordinate', true, true).has('companion__create')).toBe(true);
});
