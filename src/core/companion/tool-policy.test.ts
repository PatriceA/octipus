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

test('Companion can read todos in every mode and handle owner-requested todo writes without starting work',()=>{
  for(const mode of ['observe','coordinate','repair'] as const){
    for(const enabled of [false,true]){
      const attended=companionControllerTools(mode,enabled,true),background=companionControllerTools(mode,enabled,false);
      expect(attended.has('tasks__list_tasks')).toBe(true);expect(background.has('tasks__list_tasks')).toBe(true);
      expect(attended.has('companion__heartbeat_status')).toBe(true);
      for(const tool of ['tasks__create_task','tasks__add_tasks']){
        expect(attended.has(tool)).toBe(true);expect(background.has(tool)).toBe(false);
      }
      for(const tool of ['tasks__update_task','tasks__complete_task','tasks__add_task_comment','tasks__checkout_task','shell__run','create_pipeline','spawn_child'])expect(attended.has(tool)).toBe(false);
    }
  }
});
