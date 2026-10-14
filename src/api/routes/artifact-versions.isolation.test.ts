/**
 * Artifact versions written through the REST API keep the page's behaviour,
 * as the agent tool's do (`core/artifacts/version-writer.ts`): inline script
 * is lifted into the version's bundle, a CSS-only edit carries the bundle
 * forward, and a restore copies the restored version's bundle. The embed is
 * sandboxed by its CSP header wherever it is opened.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const userId = randomUUID();
type App = { handle(request: Request): Promise<Response> };
let app: App;
let token: string;

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  return app.handle(new Request(`http://localhost${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-artifact-versions-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { initializeStorage } = await import('@/db/storage');
  initializeStorage({ mode: 'external' });
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: userId, username: 'av-user' }]);
  const { getSessionManager } = await import('@/security/auth/session');
  token = (await getSessionManager().create(userId)).token;
  const { createServer } = await import('@/api/server');
  app = createServer();
}, 120_000);

async function hasBundle(artifactId: string, versionId: string): Promise<boolean> {
  const { bundleFilePath } = await import('@/core/artifacts/bundler');
  return existsSync(bundleFilePath(artifactId, versionId));
}

describe('artifact versions through the REST API', () => {
  test('create lifts inline script into a bundle; a CSS edit and a restore keep it', async () => {
    const { artifactsRepository } = await import('@/db/repositories/artifacts-repository');
    const created = await call('POST', '/api/artifacts', {
      slug: 'counter',
      title: 'Counter',
      type: 'html',
      htmlTemplate: '<button onclick="go()">+1</button><script>function go(){ document.title = "x"; }</script>',
    });
    expect(created.status).toBe(201);
    const { artifact, warnings } = await created.json();
    expect(warnings).toEqual([]);
    const first = (await artifactsRepository.getVersion(artifact.currentVersionId))!;
    expect(first.htmlTemplate).not.toContain('<script');
    expect(first.htmlTemplate).toContain('data-octi-h');
    expect(await hasBundle(artifact.id, first.id)).toBe(true);

    const edited = await call('PUT', `/api/artifacts/${artifact.id}`, { css: 'button { color: red; }' });
    expect(edited.status).toBe(200);
    const second = (await edited.json()).artifact.currentVersionId as string;
    expect(second).not.toBe(first.id);
    expect(await hasBundle(artifact.id, second)).toBe(true);

    const restored = await call('POST', `/api/artifacts/${artifact.id}/versions/${first.id}/restore`);
    expect(restored.status).toBe(200);
    const third = (await restored.json()).versionId as string;
    expect(await hasBundle(artifact.id, third)).toBe(true);
  });

  test('a script that does not build still saves the version, with a warning', async () => {
    const created = await call('POST', '/api/artifacts', {
      slug: 'broken',
      title: 'Broken',
      type: 'html',
      htmlTemplate: '<p>x</p><script>function (</script>',
    });
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body.artifact.currentVersionId).toBeTruthy();
    expect(body.warnings.join(' ')).toMatch(/did not build/);
  });

  test('the embed is sandboxed by its CSP header', async () => {
    const res = await call('GET', '/__artifacts__/a/counter/embed');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toMatch(/; sandbox allow-scripts$/);
  });
});
