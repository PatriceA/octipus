import { expect, test } from 'vitest';
import { stageEnvironmentReason, stageHostServices, stagePolicyRepairReason, coordinatorCriterion, coordinatorCriterionSatisfied } from './pipeline-environment';

test('policy repair reports never become generic user decisions', () => {
  expect(stagePolicyRepairReason({ blockedOnPolicy: 'Exact backup refused' }, null)).toBe('Exact backup refused');
  expect(stagePolicyRepairReason({ blockedOnDecision: { question: 'Operator policy repair required; no new user approval needed.' } }, null)).toBeDefined();
  expect(stagePolicyRepairReason({ blockedOnDecision: { question: 'Backup permission?' } }, { permissionDenials: 1 })).toBeDefined();
  expect(stagePolicyRepairReason({ blockedOnDecision: { question: 'Backup permission?' } }, { policyRefusals: ['Exact command refused'] })).toBe('Exact command refused');
  expect(stagePolicyRepairReason({ blockedOnDecision: { question: 'Which deployment window should we use?' } }, null)).toBeUndefined();
  expect(stagePolicyRepairReason(null, { permissionDenials: 1 })).toBeUndefined();
});

test.each(['go: Kommando nicht gefunden', 'go: command not found', '/home/user/.local/go/bin/go: No such file or directory',
  'ECONNREFUSED ::1:5433', '/var/run/docker.sock: no such file or directory'])
('identifies a missing gate prerequisite: %s', reason => { expect(stageEnvironmentReason(reason)).toBe(reason); });
test.each(['assertion failed: expected 2 to be 1', 'ECONNREFUSED 127.0.0.1:3007', 'missing implementation file src/new.ts', 'Tool is not available to this agent'])
('keeps code failures separate: %s', reason => { expect(stageEnvironmentReason(reason)).toBeUndefined(); });
test('only a stage declaration or an approved run can enable host access', () => {
  const pipeline = { userId: 'owner', metadata: {} };
  expect(stageHostServices({}, pipeline)).toBe(false);
  expect(stageHostServices({ hostServices: true }, pipeline)).toBe(true);
  expect(stageHostServices({}, { ...pipeline, metadata: { permissionProfile: { profile: { hostServices: true } } } })).toBe(false);
  expect(stageHostServices({}, { ...pipeline, metadata: { permissionProfile: { approvedBy: 'owner', profile: { hostServices: true } } } })).toBe(true);
});


test('a required browser gate can report a cache visibility problem', () => {
  expect(stageEnvironmentReason("Executable doesn't exist at /home/user/.cache/ms-playwright/chromium-1243/chrome")).toBeDefined();
});


test('coordinator acceptance uses the exact visible step, not a similarly prefixed step (#58)', () => {
  expect(coordinatorCriterion('The visible plan step g1 must be working')).toBe(true);
  expect(coordinatorCriterionSatisfied('The visible plan step g1 must be working', [{ id: 'g10', status: 'working' }])).toBe(false);
  expect(coordinatorCriterionSatisfied('The visible plan step g1 must be working', [{ id: 'g1', status: 'working' }])).toBe(true);
  expect(coordinatorCriterion('User-facing long names render without truncation')).toBe(false);
});
