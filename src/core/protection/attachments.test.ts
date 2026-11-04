import { beforeEach, expect, test, vi } from 'vitest';
import { prepareAttachmentProtection } from './attachments';
import { localRowInstead, ProtectionRoutingError } from './routing';
import { resetSessionLevels, sessionProtectionLevel } from './session-level';
import type { ModelConfigEntry } from '@/db/schema/models';

const state = vi.hoisted(() => ({ enabled: true }));
vi.mock('@/core/modules/registry', () => ({ isModuleOn: () => state.enabled }));
beforeEach(() => { state.enabled = true; resetSessionLevels(); });

test('an unclassified PDF asks for a choice without making the conversation level 4', () => {
  expect(() => prepareAttachmentProtection('pdf-chat', [{ path: 'brief.pdf' }])).toThrow('have not been classified');
  expect(sessionProtectionLevel('pdf-chat')).toBe(1);
});

test('every file needs a valid explicit choice; a partial batch does not raise the level', () => {
  expect(() => prepareAttachmentProtection('pdf-chat', [{ path: 'hr.pdf', protectionLevel: 4 }, { path: 'brief.pdf' }])).toThrow(ProtectionRoutingError);
  expect(() => prepareAttachmentProtection('pdf-chat', [{ path: 'brief.pdf', protectionLevel: 0 as never }])).toThrow(ProtectionRoutingError);
  expect(sessionProtectionLevel('pdf-chat')).toBe(1);
});

test('an Internal PDF can use the configured remote model', async () => {
  prepareAttachmentProtection('pdf-chat', [{ path: 'brief.pdf', protectionLevel: 2 }]);
  expect(sessionProtectionLevel('pdf-chat')).toBe(2);
  const remote = { name: 'cloud-chat', modelId: 'chat', provider: 'cli' } as ModelConfigEntry;
  const candidates = vi.fn();
  expect(await localRowInstead(remote, 'pdf-chat', 'tools', candidates)).toBe(remote);
  expect(candidates).not.toHaveBeenCalled();
});

test('Strictly confidential still requires a local model, and later choices cannot lower it', async () => {
  prepareAttachmentProtection('pdf-chat', [{ path: 'hr.pdf', protectionLevel: 4 }]);
  prepareAttachmentProtection('pdf-chat', [{ path: 'public.pdf', protectionLevel: 1 }]);
  expect(sessionProtectionLevel('pdf-chat')).toBe(4);
  const remote = { name: 'cloud-chat', modelId: 'chat', provider: 'cli' } as ModelConfigEntry;
  await expect(localRowInstead(remote, 'pdf-chat', 'tools', async () => ({ defaultModel: null, rows: [] }))).rejects.toThrow('protection level 4');
});

test('disabled protection preserves the conservative level for files actually processed', () => {
  state.enabled = false;
  prepareAttachmentProtection('pdf-chat', [{ path: 'brief.pdf' }]);
  expect(sessionProtectionLevel('pdf-chat')).toBe(4);
});
