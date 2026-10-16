import { describe, expect, test } from 'vitest';
import { routeApprovalFor } from './approval-route';
import { rememberApprovedCall } from './approved-calls';

describe('a call approved for a parked pipeline stage (#12)', () => {
  const caller = { userId: 'u', sessionId: 'approved-session', role: 'qa', attended: true };
  const call = (command: string) => ({ toolId: 'cli-native:Bash', action: 'Bash', toolName: 'Bash', args: { command, description: 'any' } });
  test('executes the identical call in the same session, and nothing else', async () => {
    expect(rememberApprovedCall('approved-session', call('docker compose build'))).toBe(true);
    await expect(routeApprovalFor(caller, call('docker compose build'), { level: 'ASK' })).resolves.toMatchObject({ route: 'execute', source: 'pipeline-approval' });
    await expect(routeApprovalFor(caller, call('docker compose down'), { level: 'ASK' })).resolves.toMatchObject({ route: 'ask_human' });
    await expect(routeApprovalFor({ ...caller, sessionId: 'other' }, call('docker compose build'), { level: 'ASK' })).resolves.toMatchObject({ route: 'ask_human' });
    await expect(routeApprovalFor(caller, call('docker compose build'), { level: 'DENY' })).resolves.toMatchObject({ route: 'deny' });
  });
});
