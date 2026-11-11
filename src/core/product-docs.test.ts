import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { ProductDocs } from './product-docs';
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'octipus-manual-')); roots.push(root);
  writeFileSync(join(root, 'CHANNELS.md'), '# Channels\n## Telegram\nCreate a bot using BotFather.\n## Slack\nConnect Slack using app credentials.');
  writeFileSync(join(root, 'MODELS.md'), '# Models\n## Local embedding models\nUser documents can use local embeddings.');
  return { root, docs: new ProductDocs(root) };
}
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('manual is completely lazy and works without any model/DB configuration', async () => {
  expect(() => new ProductDocs('/missing/manual')).not.toThrow();
  const { docs } = fixture();
  const hits = await docs.search('how do I configure Telegram BotFather');
  expect(hits[0]).toMatchObject({ file: 'CHANNELS.md', heading: 'Telegram' });
  expect(hits[0].line).toBeGreaterThan(0);
  expect(hits[0].excerpt).toContain('BotFather');
  expect((await docs.read(hits[0].file, hits[0].line)).content).toContain('BotFather');
  expect(await docs.search('xyzzymissing')).toEqual([]);
});
test('source excerpts are bounded and paths are restricted to the bundled catalog', async () => {
  const { docs } = fixture();
  await expect(docs.read('../private.md')).rejects.toThrow('bundled documentation');
  await expect(docs.read('/etc/passwd')).rejects.toThrow('bundled documentation');
  await expect(docs.read('CHANNELS.md', 0)).rejects.toThrow('positive');
  await expect(docs.read('CHANNELS.md', 1, 121)).rejects.toThrow('120');
  expect(await docs.read('CHANNELS.md', 2, 1)).toMatchObject({ line: 2, content: '2: ## Telegram', truncated: true });
});
test('internal plans, generated files and symlinked user content never enter the catalog', async () => {
  const { root, docs } = fixture();
  mkdirSync(join(root, 'plans')); writeFileSync(join(root, 'plans', 'secret.md'), '# secretmarker');
  mkdirSync(join(root, 'architecture')); mkdirSync(join(root, 'architecture', 'generated'));
  writeFileSync(join(root, 'architecture', 'generated', 'noise.md'), '# secretmarker');
  writeFileSync(join(root, 'CHANGELOG.md'), '# secretmarker');
  if (process.platform !== 'win32') symlinkSync('/etc/passwd', join(root, 'private.md'));
  expect(await docs.search('secretmarker')).toEqual([]);
  await expect(docs.read('plans/secret.md')).rejects.toThrow('bundled documentation');
  await expect(docs.read('private.md')).rejects.toThrow('bundled documentation');
});
test('query/response limits are enforced and a later request refreshes changed manual content', async () => {
  const { root, docs } = fixture(); vi.useFakeTimers();
  await expect(docs.search('x'.repeat(501))).rejects.toThrow('500');
  await expect(docs.search('Telegram', 100)).rejects.toThrow('10');
  expect(await docs.search('refreshmarker')).toEqual([]);
  writeFileSync(join(root, 'NEW.md'), '# refreshmarker\nNew local help.');
  vi.advanceTimersByTime(60_001);
  expect((await docs.search('refreshmarker'))[0].file).toBe('NEW.md');
});

test('setup synonyms and parent section names lead to setup instructions', async () => {
  const { root, docs } = fixture();
  writeFileSync(join(root, 'CHANNELS.md'), '# Channels\n## Telegram\n### Setup\nCreate a bot with BotFather.\n### Bot Commands\nThe bot supports commands.');
  expect((await docs.search('configure Telegram bot', 1))[0]).toMatchObject({ heading: 'Telegram › Setup' });
});
