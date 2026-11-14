/**
 * A child whose model reads images gets the images its task names; a blind
 * child or a CLI agent gets the paths only (worker-spawner.ts mediaNamedIn).
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { AgentContext } from '@/core/types';

const root = vi.hoisted(() => ({ dir: '' }));
vi.mock('@/security/workspace-fs', async (orig) => {
  const real = await orig<typeof import('@/security/workspace-fs')>();
  const TestFS = new Proxy(real.WorkspaceFS, {
    get: (target, prop, receiver) => (prop === 'forAgent' ? () => target.withRoot(root.dir) : Reflect.get(target, prop, receiver)),
  });
  return { ...real, WorkspaceFS: TestFS };
});

const { mediaNamedIn } = await import('./worker-spawner');
const ctx = { id: 'a', userId: 'u', sessionId: 's' } as unknown as AgentContext;

beforeEach(async () => {
  root.dir = await mkdtemp(join(tmpdir(), 'octipus-child-'));
  await mkdir(join(root.dir, '.octipus/media/generated'), { recursive: true });
  await writeFile(join(root.dir, '.octipus/media/generated/sign.png'), await sharp({ create: { width: 4, height: 4, channels: 3, background: '#fff' } }).png().toBuffer());
});
afterEach(async () => { await rm(root.dir, { recursive: true, force: true }); });

test('the images a task names go to a seeing child; never to a blind one or a CLI agent', async () => {
  const task = 'Check the sign in .octipus/media/generated/sign.png and the missing .octipus/media/generated/gone.png';
  const refs = await mediaNamedIn(task, ctx, { supportsVision: true, provider: 'anthropic' });
  expect(refs).toHaveLength(1);
  expect(refs[0]).toMatchObject({ kind: 'image', mimeType: 'image/png', source: 'user' });
  await expect(mediaNamedIn(task, ctx, { supportsVision: false, provider: 'openai' })).resolves.toEqual([]);
  await expect(mediaNamedIn(task, ctx, { supportsVision: true, provider: 'cli' })).resolves.toEqual([]);
  await expect(mediaNamedIn('no images here', ctx, { supportsVision: true, provider: 'anthropic' })).resolves.toEqual([]);
});
