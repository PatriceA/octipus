import { describe, expect, it } from 'vitest';
import { configSchema } from './schema';
import { SETTINGS_REGISTRY } from './settings-registry';

/** `skills.registries` (docs/SKILL-EXCHANGE.md#registries): none by default, https only, unique names. */
const skills = (value: unknown) => configSchema.shape.skills.safeParse(value);

describe('skills.registries', () => {
  it('is empty by default, in the schema and the settings registry: no registry is contacted unless an operator adds one', () => {
    const parsed = skills({});
    expect(parsed.success && parsed.data.registries).toEqual([]);
    expect(SETTINGS_REGISTRY.find((s) => s.key === 'skills.registries')).toMatchObject({ defaultValue: [], valueType: 'json' });
  });

  it('takes named https indexes with the publishers trusted for each', () => {
    expect(skills({ registries: [{ name: 'Acme', url: 'https://skills.example.com/index.json', publishers: ['Acme'] }] }).success).toBe(true);
    expect(skills({ registries: [{ name: 'Acme', url: 'http://skills.example.com/index.json' }] }).success).toBe(false);
    expect(skills({ registries: [{ name: 'Acme', url: 'https://a.example.com/i.json' }, { name: 'acme', url: 'https://b.example.com/i.json' }] }).success).toBe(false);
    expect(skills({ registries: [{ name: 'Acme', url: 'https://a.example.com/i.json', trustAll: true }] }).success).toBe(false);
  });
});
