import { expect, test } from 'vitest';
import { stageEnvironmentReason, stageHostServices } from './pipeline-environment';

test.each(['go: Kommando nicht gefunden', 'go: command not found', '/home/user/.local/go/bin/go: No such file or directory',
  'ECONNREFUSED ::1:5433', '/var/run/docker.sock: no such file or directory', 'Tool is not available to this agent'])
('identifies a missing gate prerequisite: %s', reason => { expect(stageEnvironmentReason(reason)).toBe(reason); });
test.each(['assertion failed: expected 2 to be 1', 'ECONNREFUSED 127.0.0.1:3007', 'missing implementation file src/new.ts'])
('keeps code failures separate: %s', reason => { expect(stageEnvironmentReason(reason)).toBeUndefined(); });
test('only a stage declaration or an approved run can enable host access', () => {
  const pipeline = { userId: 'owner', metadata: {} };
  expect(stageHostServices({}, pipeline)).toBe(false);
  expect(stageHostServices({ hostServices: true }, pipeline)).toBe(true);
  expect(stageHostServices({}, { ...pipeline, metadata: { permissionProfile: { profile: { hostServices: true } } } })).toBe(false);
  expect(stageHostServices({}, { ...pipeline, metadata: { permissionProfile: { approvedBy: 'owner', profile: { hostServices: true } } } })).toBe(true);
});
