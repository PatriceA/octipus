import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import type { PermissionRequest } from '../schema/permissions';
import { recoveryActionIds } from './recovery-consent';
const request = (args: Record<string, unknown>, action='retry', toolId='action_recovery') => ({toolId,action,sessionId:randomUUID(),context:{toolArguments:args}} as PermissionRequest);
test('machine-readable snapshots cover all displayed and undisplayed actions, with no prose inference', () => {
  const ids=Array.from({length:65},()=>randomUUID());
  expect(recoveryActionIds(request({recoveryActionIds:ids,previousActions:'only twenty actions displayed'}))).toEqual(ids);
  expect(recoveryActionIds(request({recoveryActionIds:['invalid'],previousActions:`- shell__run at 2026-11-03T20:16:35.626Z: unknown; record ${ids[0]}`}))).toEqual([]);
});
test('legacy consent matches only server-formatted record lines, never an arbitrary UUID or a normal tool approval', () => {
  const id=randomUUID();const args={previousActions:`- shell__run at 2026-11-03T20:16:35.626Z: outcome unknown; record ${id}`};
  expect(recoveryActionIds(request(args))).toEqual([id]);
  expect(recoveryActionIds(request({previousActions:`inspect record ${id}`}))).toEqual([]);
  expect(recoveryActionIds(request(args,'execute','shell'))).toEqual([]);
  expect(recoveryActionIds(request({warning:args.previousActions},'replay_pipeline'))).toEqual([id]);
});
