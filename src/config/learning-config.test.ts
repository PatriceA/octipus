import { describe, expect, it } from 'vitest';
import { configSchema } from './schema';
import { validateSettingValue } from './schema-introspect';
import { SETTINGS_REGISTRY } from './settings-registry';

/**
 * Every `learning.*` key is an operator setting (Settings → Configuration →
 * Agent & Root agent → Learning), registered with the schema's default, so
 * the runtime loader reads a stored value instead of always the code default;
 * the schema's bounds apply to a write.
 */
describe('learning settings', () => {
  const defaults = configSchema.shape.learning.parse({});

  it.each(Object.entries(defaults))('learning.%s is registered with the schema default', (key, value) => {
    const entry = SETTINGS_REGISTRY.find((s) => s.key === `learning.${key}`);
    expect(entry).toMatchObject({ category: 'learning', valueType: 'number', defaultValue: value, isSecret: false });
  });

  it('writes are held to the schema bounds', () => {
    expect(validateSettingValue('learning.recurrenceSessions', 0).ok).toBe(false);
    expect(validateSettingValue('learning.duplicateSimilarity', 1.5).ok).toBe(false);
    expect(validateSettingValue('learning.reviewEveryToolCalls', 2.5).ok).toBe(false);
    expect(validateSettingValue('learning.candidateTtlDays', 7).ok).toBe(true);
    expect(validateSettingValue('learning.maxSkillProposalsPerDay', 0).ok).toBe(true);
  });
});
