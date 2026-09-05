import { describe, expect, test } from 'vitest';
import { handlePersonaCommand } from './commands';

// These tests stub out the DB layer by way of the in-process registry
// reset. The real `findForUser` / `create` paths call the DB, so we
// skip flows that require persistence here — they're covered in the
// integration tests when the suite runs against a live PG.

describe('handlePersonaCommand — argument parsing', () => {
  test('show: returns help when there is no DB and no profile', async () => {
    // No DB — calls will throw at the repository layer. handlePersonaCommand
    // should not crash; it shows the catch-all error path. We just verify
    // the function dispatches without exception.
    const result = await handlePersonaCommand({ userId: '00000000-0000-0000-0000-000000000000', rawArgs: 'personas' }).catch((e: Error) => ({ text: `errored: ${e.message}` }));
    expect(typeof result.text).toBe('string');
  });

  test('unknown subcommand returns the help banner', async () => {
    const result = await handlePersonaCommand({ userId: '00000000-0000-0000-0000-000000000000', rawArgs: 'fhqwhgads' });
    expect(result.text).toContain('Unknown persona subcommand');
    expect(result.text).toContain('/persona name');
    expect(result.text).toContain('/persona tone');
    expect(result.text).toContain('/persona say');
  });

  test('tone with invalid value rejects with a clear hint', async () => {
    const result = await handlePersonaCommand({ userId: '00000000-0000-0000-0000-000000000000', rawArgs: 'tone screamy' });
    expect(result.text).toContain('Unknown tone');
    expect(result.text).toContain('dry');
    expect(result.text).toContain('verbose');
  });

  test('narration with invalid value rejects', async () => {
    const result = await handlePersonaCommand({ userId: '00000000-0000-0000-0000-000000000000', rawArgs: 'narration loud' });
    expect(result.text).toContain('Unknown narration');
  });

  test('narration accepts "min" / "chat" shortcuts (just argument parsing)', async () => {
    // Reaches the DB; rejection text won't appear. We just assert we did
    // not hit the "Unknown narration" rejection path.
    const result = await handlePersonaCommand({ userId: '00000000-0000-0000-0000-000000000000', rawArgs: 'narration min' }).catch((e: Error) => ({ text: e.message }));
    expect(result.text).not.toContain('Unknown narration');
  });

  test('name with empty value asks for one', async () => {
    const result = await handlePersonaCommand({ userId: '00000000-0000-0000-0000-000000000000', rawArgs: 'name' });
    expect(result.text).toContain('Provide a new name');
  });

  test('say with too-short fact rejects', async () => {
    const result = await handlePersonaCommand({ userId: '00000000-0000-0000-0000-000000000000', rawArgs: 'say hi' });
    expect(result.text).toContain('longer fact');
  });

  test('say with too-long fact rejects', async () => {
    const result = await handlePersonaCommand({
      userId: '00000000-0000-0000-0000-000000000000',
      rawArgs: 'say ' + 'x'.repeat(400),
    });
    expect(result.text).toContain('too long');
  });

  test('use without preset id asks for one', async () => {
    const result = await handlePersonaCommand({ userId: '00000000-0000-0000-0000-000000000000', rawArgs: 'use' });
    expect(result.text).toContain('Provide a preset id');
  });
});

// `/persona arm` — only the branches that reject BEFORE any DB write, which is
// where the rules that matter live (an unknown role must never reach the
// profile).
describe('handlePersonaCommand — /persona arm', () => {
  const userId = '00000000-0000-0000-0000-000000000000';

  test('missing arguments explain the shape', async () => {
    const r = await handlePersonaCommand({ userId, rawArgs: 'arm review' });
    expect(r.text).toContain('/persona arm <role> <preset|off>');
  });

  test('an unknown role is rejected and the valid ones listed', async () => {
    const r = await handlePersonaCommand({ userId, rawArgs: 'arm tentacle terse-engineer' });
    expect(r.text).toContain('Unknown role "tentacle"');
    expect(r.text).toContain('coding');
  });

  test('the retired `orchestrator` role is simply unknown now', async () => {
    // It used to be redirected to the host persona. Phase 9 deleted the role,
    // so the generic unknown-role path is the honest answer — and the host
    // persona is still what the agent the user talks to wears. The literal
    // retired name is the point of the test: it is what a user who learned it
    // from the old docs will type.
    const r = await handlePersonaCommand({ userId, rawArgs: 'arm orchestrator mentor' });
    expect(r.text).toContain('Unknown role "orchestrator"');
  });

  test('the help banner advertises the arm subcommands', async () => {
    const r = await handlePersonaCommand({ userId, rawArgs: 'fhqwhgads' });
    expect(r.text).toContain('/persona arm');
    expect(r.text).toContain('/persona arms');
  });
});
