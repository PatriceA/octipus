import { expect, test } from 'vitest';
import { companionBoundModel, isCompanionControllerModel } from './model-binding';
import { startCompanionSessionSchema } from '@/shared/companion-supervision';

test('Companion project sessions route by topic, including ones that stored a model before', () => {
  expect(companionBoundModel({ companion: { goalId: 'g' } })).toBeUndefined();
  expect(companionBoundModel({ companion: { goalId: 'g', modelName: 'test-only-model' } })).toBeUndefined();
  expect(companionBoundModel(undefined)).toBeUndefined();
});

test('the supervisor and maintenance sessions stay on the Companion model', () => {
  expect(companionBoundModel({ companionSupervisor: { modelName: 'companion-api' } })).toBe('companion-api');
  expect(companionBoundModel({ companion: { goalId: 'g', modelName: 'companion-api' },
    companionMaintenance: { binding: 'b', authorityRevision: 1 } })).toBe('companion-api');
});

test('one eligibility rule for the Companion model, case-insensitive', () => {
  const api = { provider: 'openrouter', supportsTools: true, modelId: 'deepseek-chat' };
  expect(isCompanionControllerModel(api)).toBe(true);
  expect(isCompanionControllerModel({ ...api, provider: 'cli' })).toBe(false);
  expect(isCompanionControllerModel({ ...api, supportsTools: false })).toBe(false);
  expect(isCompanionControllerModel({ ...api, modelId: 'Qwen-Thinking' })).toBe(false);
  expect(isCompanionControllerModel({ ...api, modelId: 'deepseek-ocr' })).toBe(false);
  expect(isCompanionControllerModel(null)).toBe(false);
});

test('a model name from an older client or an earlier turn is dropped, not refused', () => {
  const key = '00000000-0000-4000-8000-000000000000';
  expect(startCompanionSessionSchema.parse({ requestKey: key, expectedRevision: 0, modelName: 'old' })).toEqual({ requestKey: key, expectedRevision: 0 });
  expect(() => startCompanionSessionSchema.parse({ requestKey: key, expectedRevision: 0, other: 1 })).toThrow();
});
