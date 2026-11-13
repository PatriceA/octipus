/**
 * The Teams SDK (botbuilder) runs on zod 4: package.json overrides its zod 3
 * (GHSA-mrhx-c7xc-m3w5 has no zod 3 fix) and scripts/patch-botbuilder-zod4.mjs
 * adapts the calls zod 4 dropped at install. If an install skipped the
 * patch, or a new botbuilder needs more, this fails before the channel does.
 */
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { describe, expect, test } from 'vitest';
import { PACKAGES, patchBotbuilder, patchSource, ZOD3_ONLY } from '../../../scripts/patch-botbuilder-zod4.mjs';

const require = createRequire(import.meta.url);

describe('botbuilder on zod 4', () => {
  test('the patch renames the zod 3 calls, and only those', () => {
    const before = "const T = z.object({ a: z.string() }).nonstrict();\nthrow new Error(JSON.stringify(err.errors, null, 2));\nconst list = res.errors;";
    const after = patchSource(before);
    expect(after).toBe("const T = z.object({ a: z.string() }).passthrough();\nthrow new Error(JSON.stringify(err.issues, null, 2));\nconst list = res.errors;");
    expect(ZOD3_ONLY.test(after)).toBe(false);
    expect(patchSource(after)).toBe(after);
  });

  test('every SDK package resolves zod 4, and none still calls zod 3', () => {
    for (const name of PACKAGES) {
      const root = dirname(require.resolve(`${name}/package.json`));
      const zod = require(require.resolve('zod/package.json', { paths: [root] })) as { version: string };
      expect(zod.version, name).toMatch(/^4\./);
    }
    // Already applied at install: nothing left to change, nothing left over.
    expect(patchBotbuilder(process.cwd())).toEqual({ patched: [], remaining: [] });
  });

  test('the SDK loads and still validates what it validated on zod 3', async () => {
    const bb = require('botbuilder') as typeof import('botbuilder');
    const schema = require('botframework-schema') as typeof import('botframework-schema');

    expect(() => new bb.ConfigurationBotFrameworkAuthentication({ MicrosoftAppId: 1 } as never)).toThrow(/MicrosoftAppId/);
    const auth = new bb.ConfigurationBotFrameworkAuthentication({ MicrosoftAppId: 'x', MicrosoftAppPassword: 'y', MicrosoftAppType: 'MultiTenant' });
    const adapter = new bb.CloudAdapter(auth);

    const activity = {
      type: 'message', id: '1', text: 'hi', channelId: 'msteams', serviceUrl: 'https://smba.trafficmanager.net/emea/', localTimezone: 'UTC', callerId: 'c', label: 'l', valueType: 'v',
      from: { id: 'u', name: 'U', aadObjectId: 'a' }, recipient: { id: 'b', name: 'B' }, conversation: { id: 'c', isGroup: false, conversationType: 'personal', name: 'n' },
      entities: [{ type: 'mention' }], attachments: [{ contentType: 'text/plain', content: 'x' }],
    };
    expect(() => schema.assertActivity(activity, ['activity'])).not.toThrow();
    expect(schema.isActivity({ ...activity, entities: [{}] })).toBe(false);
    expect(schema.isActivity({ ...activity, from: { id: 'u' } })).toBe(false);

    // An unsigned request is refused (the call the Teams channel makes); a body that is not an activity too.
    const direct = adapter as unknown as { processActivity(auth: string, activity: unknown, logic: () => Promise<void>): Promise<void> };
    await expect(direct.processActivity('Bearer not-a-token', activity, async () => {})).rejects.toThrow(/Unauthorized/);
    const statuses: number[] = [];
    const res = { status(c: number) { statuses.push(c); return res; }, header: () => res, send: () => res, end: () => res };
    await adapter.process({ body: activity, headers: { authorization: 'Bearer not-a-token' }, method: 'POST' } as never, res as never, async () => {});
    await adapter.process({ body: 'nope', headers: {}, method: 'POST' } as never, res as never, async () => {});
    expect(statuses).toEqual([401, 400]);

    expect(typeof new bb.TeamsActivityHandler().run).toBe('function');
    expect(bb.MessageFactory.text('hey').type).toBe('message');
  });
});
