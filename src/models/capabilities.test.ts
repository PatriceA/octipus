import { describe, test, expect } from 'bun:test';
import {
  getCapabilitiesForModel,
  PROVIDER_CAPABILITY_DEFAULTS,
  type ModelCapabilities,
} from './capabilities';
import type { ModelConfigEntry } from '@/db/schema/models';

// ── Helpers ───────────────────────────────────────────────────

/**
 * Build a minimal ModelConfigEntry for testing purposes.
 * All boolean capability fields default to the DB schema defaults.
 */
function makeModel(
  provider: string,
  overrides: Partial<ModelConfigEntry> = {},
): ModelConfigEntry {
  return {
    id: 'test-id',
    name: 'Test Model',
    provider,
    modelId: 'test-model',
    endpoint: null,
    apiKeyRef: null,
    maxTokens: 4096,
    contextWindow: 128000,
    supportsVision: false,
    supportsTools: true,
    supportsStreaming: true,
    defaultTemperature: 0.7,
    defaultTopP: 1.0,
    defaultMaxTokens: 4096,
    topics: [],
    priority: 0,
    topicRoles: {},
    costPerInputToken: 0,
    costPerOutputToken: 0,
    isEnabled: true,
    isDefault: false,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as ModelConfigEntry;
}

// ── Provider defaults ─────────────────────────────────────────

describe('PROVIDER_CAPABILITY_DEFAULTS', () => {
  test('ollama defaults: tools=true, embeddings=true, streaming=true', () => {
    const caps = PROVIDER_CAPABILITY_DEFAULTS['ollama'];
    expect(caps.tools).toBe(true);
    expect(caps.embeddings).toBe(true);
    expect(caps.streaming).toBe(true);
    expect(caps.multiturn).toBe(true);
    expect(caps.systemRole).toBe(true);
  });

  test('ollama does not claim media or structuredOutput', () => {
    const caps = PROVIDER_CAPABILITY_DEFAULTS['ollama'];
    expect(caps.media).toBe(false);
    expect(caps.structuredOutput).toBe(false);
  });

  test('openai: all capabilities true', () => {
    const caps = PROVIDER_CAPABILITY_DEFAULTS['openai'];
    expect(caps.multiturn).toBe(true);
    expect(caps.media).toBe(true);
    expect(caps.tools).toBe(true);
    expect(caps.streaming).toBe(true);
    expect(caps.systemRole).toBe(true);
    expect(caps.embeddings).toBe(true);
    expect(caps.structuredOutput).toBe(true);
  });

  test('anthropic: tools+streaming+media but no embeddings or structuredOutput', () => {
    const caps = PROVIDER_CAPABILITY_DEFAULTS['anthropic'];
    expect(caps.tools).toBe(true);
    expect(caps.streaming).toBe(true);
    expect(caps.media).toBe(true);
    expect(caps.embeddings).toBe(false);
    expect(caps.structuredOutput).toBe(false);
  });

  test('gemini: systemRole=false (converted to user turn)', () => {
    const caps = PROVIDER_CAPABILITY_DEFAULTS['gemini'];
    expect(caps.systemRole).toBe(false);
    expect(caps.tools).toBe(true);
    expect(caps.streaming).toBe(true);
    expect(caps.embeddings).toBe(false);
  });

  test('deepseek: structuredOutput=true, embeddings=false, media=false', () => {
    const caps = PROVIDER_CAPABILITY_DEFAULTS['deepseek'];
    expect(caps.structuredOutput).toBe(true);
    expect(caps.embeddings).toBe(false);
    expect(caps.media).toBe(false);
    expect(caps.tools).toBe(true);
  });

  test('voyage: embeddings-only provider — everything false except embeddings', () => {
    const caps = PROVIDER_CAPABILITY_DEFAULTS['voyage'];
    expect(caps.embeddings).toBe(true);
    expect(caps.tools).toBe(false);
    expect(caps.multiturn).toBe(false);
    expect(caps.media).toBe(false);
    expect(caps.streaming).toBe(false);
    expect(caps.systemRole).toBe(false);
    expect(caps.structuredOutput).toBe(false);
  });

  test('cli: tools+multiturn+systemRole but no streaming or embeddings', () => {
    const caps = PROVIDER_CAPABILITY_DEFAULTS['cli'];
    expect(caps.tools).toBe(true);
    expect(caps.multiturn).toBe(true);
    expect(caps.systemRole).toBe(true);
    expect(caps.streaming).toBe(false);
    expect(caps.embeddings).toBe(false);
  });

  test('litellm: all capabilities true (permissive proxy default)', () => {
    const caps = PROVIDER_CAPABILITY_DEFAULTS['litellm'];
    const keys = Object.keys(caps) as (keyof ModelCapabilities)[];
    for (const key of keys) {
      expect(caps[key]).toBe(true);
    }
  });

  test('every provider entry has all 7 capability keys', () => {
    const requiredKeys: (keyof ModelCapabilities)[] = [
      'multiturn', 'media', 'tools', 'streaming', 'systemRole', 'embeddings', 'structuredOutput',
    ];
    for (const [provider, caps] of Object.entries(PROVIDER_CAPABILITY_DEFAULTS)) {
      for (const key of requiredKeys) {
        expect(caps[key], `${provider}.${key} should be a boolean`).toBeTypeOf('boolean');
      }
    }
  });
});

// ── getCapabilitiesForModel ───────────────────────────────────

describe('getCapabilitiesForModel', () => {
  describe('provider defaults', () => {
    test('uses ollama defaults for an ollama model', () => {
      const model = makeModel('ollama');
      // DB flags match provider defaults so they should not conflict
      const caps = getCapabilitiesForModel({ ...model, supportsTools: true, supportsVision: false, supportsStreaming: true });
      expect(caps.embeddings).toBe(true);
      expect(caps.media).toBe(false);
    });

    test('uses openai defaults for an openai model', () => {
      const model = makeModel('openai', { supportsVision: true, supportsTools: true, supportsStreaming: true });
      const caps = getCapabilitiesForModel(model);
      expect(caps.structuredOutput).toBe(true);
      expect(caps.embeddings).toBe(true);
    });
  });

  describe('unknown provider fallback', () => {
    test('unknown provider falls back to all-false baseline', () => {
      const model = makeModel('unknown-provider-xyz');
      // Force DB flags to undefined to avoid overriding the fallback
      const caps = getCapabilitiesForModel({
        ...model,
        supportsTools: undefined as unknown as boolean,
        supportsVision: undefined as unknown as boolean,
        supportsStreaming: undefined as unknown as boolean,
      });
      expect(caps.multiturn).toBe(false);
      expect(caps.media).toBe(false);
      expect(caps.tools).toBe(false);
      expect(caps.streaming).toBe(false);
      expect(caps.systemRole).toBe(false);
      expect(caps.embeddings).toBe(false);
      expect(caps.structuredOutput).toBe(false);
    });

    test('unknown provider with DB flags applies the flags on top of all-false', () => {
      const model = makeModel('unknown-provider-xyz', {
        supportsTools: true,
        supportsVision: false,
        supportsStreaming: true,
      });
      const caps = getCapabilitiesForModel(model);
      expect(caps.tools).toBe(true);
      expect(caps.media).toBe(false);
      expect(caps.streaming).toBe(true);
      // Fields not covered by DB flags stay false
      expect(caps.embeddings).toBe(false);
      expect(caps.multiturn).toBe(false);
    });
  });

  describe('DB flag overrides', () => {
    test('supportsTools=false overrides provider default of true (ollama)', () => {
      const model = makeModel('ollama', { supportsTools: false });
      const caps = getCapabilitiesForModel(model);
      expect(caps.tools).toBe(false);
    });

    test('supportsVision=true overrides provider default of false (ollama)', () => {
      const model = makeModel('ollama', { supportsVision: true });
      const caps = getCapabilitiesForModel(model);
      expect(caps.media).toBe(true);
    });

    test('supportsStreaming=false overrides provider default of true (openai)', () => {
      const model = makeModel('openai', { supportsStreaming: false });
      const caps = getCapabilitiesForModel(model);
      expect(caps.streaming).toBe(false);
    });

    test('DB flags only override the three specific fields, not others', () => {
      const model = makeModel('openai', {
        supportsTools: false,
        supportsVision: false,
        supportsStreaming: false,
      });
      const caps = getCapabilitiesForModel(model);
      // These three are overridden
      expect(caps.tools).toBe(false);
      expect(caps.media).toBe(false);
      expect(caps.streaming).toBe(false);
      // Provider defaults survive for un-overridden fields
      expect(caps.structuredOutput).toBe(true);
      expect(caps.embeddings).toBe(true);
      expect(caps.multiturn).toBe(true);
    });
  });

  describe('metadata.capabilities override', () => {
    test('metadata.capabilities overrides provider defaults for fields not covered by DB flags', () => {
      // embeddings and structuredOutput are not DB-flag fields, so metadata wins.
      // tools is covered by supportsTools DB flag — the DB flag (true by default) wins over metadata.
      const model = makeModel('openai', {
        // DB flags are undefined — omit them so they don't override metadata for tools
        supportsTools: undefined as unknown as boolean,
        supportsVision: undefined as unknown as boolean,
        supportsStreaming: undefined as unknown as boolean,
        metadata: {
          capabilities: {
            embeddings: false,
            structuredOutput: false,
            tools: false,
          },
        } as any,
      });
      const caps = getCapabilitiesForModel(model);
      expect(caps.embeddings).toBe(false);
      expect(caps.structuredOutput).toBe(false);
      expect(caps.tools).toBe(false); // metadata wins since DB flag is undefined
      // Fields not in metadata.capabilities still inherit from provider
      expect(caps.multiturn).toBe(true);
    });

    test('metadata.capabilities partial override merges with provider defaults', () => {
      const model = makeModel('anthropic', {
        metadata: {
          capabilities: { embeddings: true },
        } as any,
      });
      const caps = getCapabilitiesForModel(model);
      // metadata says embeddings=true, overriding anthropic default of false
      expect(caps.embeddings).toBe(true);
      // Other anthropic defaults stay
      expect(caps.tools).toBe(true);
      expect(caps.streaming).toBe(true);
    });

    test('DB flags are still applied after metadata.capabilities merge', () => {
      // metadata sets tools=true, but DB flag says false — DB flag wins
      const model = makeModel('anthropic', {
        supportsTools: false,
        metadata: {
          capabilities: { tools: true },
        } as any,
      });
      const caps = getCapabilitiesForModel(model);
      expect(caps.tools).toBe(false);
    });

    test('model with no metadata returns provider defaults', () => {
      const model = makeModel('gemini', { metadata: {} });
      const caps = getCapabilitiesForModel(model);
      expect(caps.systemRole).toBe(false); // gemini default
    });
  });

  describe('return shape', () => {
    test('always returns an object with all 7 fields', () => {
      const model = makeModel('ollama');
      const caps = getCapabilitiesForModel(model);
      expect(typeof caps.multiturn).toBe('boolean');
      expect(typeof caps.media).toBe('boolean');
      expect(typeof caps.tools).toBe('boolean');
      expect(typeof caps.streaming).toBe('boolean');
      expect(typeof caps.systemRole).toBe('boolean');
      expect(typeof caps.embeddings).toBe('boolean');
      expect(typeof caps.structuredOutput).toBe('boolean');
    });
  });
});
