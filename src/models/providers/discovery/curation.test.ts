import { describe, expect, it } from 'bun:test';
import { applyTierInference, curate, inferTier } from './curation';

const NOW = Date.now();
const RECENT = NOW - 30 * 24 * 60 * 60 * 1000; // 30 days ago
const OLD = NOW - 5 * 365 * 24 * 60 * 60 * 1000; // 5 years ago

describe('inferTier', () => {
  it('classifies flagship', () => {
    expect(inferTier('claude-opus-4-6')).toBe('flagship');
    expect(inferTier('gpt-5')).toBe('flagship');
    expect(inferTier('gemini-2.5-pro')).toBe('flagship');
  });

  it('classifies cheap', () => {
    expect(inferTier('claude-haiku-4-5')).toBe('cheap');
    expect(inferTier('gpt-4o-mini')).toBe('cheap');
    expect(inferTier('gemini-2.5-flash-lite')).toBe('cheap');
  });

  it('classifies balanced', () => {
    expect(inferTier('claude-sonnet-4-6')).toBe('balanced');
    expect(inferTier('gpt-4o')).toBe('balanced');
    expect(inferTier('gemini-2.5-flash')).toBe('balanced');
  });

  it('classifies reasoning', () => {
    expect(inferTier('o3')).toBe('reasoning');
    expect(inferTier('o4-mini')).toBe('reasoning');
  });

  it('classifies Grok models', () => {
    expect(inferTier('grok-4')).toBe('flagship');
    expect(inferTier('grok-4.20')).toBe('flagship');
    expect(inferTier('grok-4-fast-reasoning')).toBe('reasoning');
    expect(inferTier('grok-4-1-fast-reasoning')).toBe('reasoning');
    expect(inferTier('grok-4-fast-non-reasoning')).toBe('cheap');
  });
});

describe('curate', () => {
  it('drops non-chat by default', () => {
    const out = curate(applyTierInference([
      { id: 'gpt-4o', label: 'GPT-4o', provider: 'openai', createdAt: RECENT },
      { id: 'text-embedding-3-large', label: 'Embedding', provider: 'openai', createdAt: RECENT },
      { id: 'whisper-1', label: 'Whisper', provider: 'openai', createdAt: RECENT },
    ]), 'live');
    const ids = out.shortlist.map(m => m.id);
    expect(ids).toContain('gpt-4o');
    expect(ids).not.toContain('text-embedding-3-large');
    expect(ids).not.toContain('whisper-1');
    expect(out.hiddenCount).toBe(2);
  });

  it('drops models older than recency window', () => {
    const out = curate(applyTierInference([
      { id: 'gpt-4o', label: 'GPT-4o', provider: 'openai', createdAt: RECENT },
      { id: 'gpt-3.5-turbo', label: 'GPT-3.5', provider: 'openai', createdAt: OLD },
    ]), 'live');
    const ids = out.shortlist.map(m => m.id);
    expect(ids).toContain('gpt-4o');
    expect(ids).not.toContain('gpt-3.5-turbo');
  });

  it('drops preview unless includePreview', () => {
    const inputs = applyTierInference([
      { id: 'gpt-5', label: 'GPT-5', provider: 'openai', createdAt: RECENT },
      { id: 'gpt-5-preview', label: 'GPT-5 Preview', provider: 'openai', createdAt: RECENT, isPreview: true },
    ]);
    const noPrev = curate(inputs, 'live').shortlist.map(m => m.id);
    const withPrev = curate(inputs, 'live', undefined, { includePreview: true }).shortlist.map(m => m.id);
    expect(noPrev).not.toContain('gpt-5-preview');
    expect(withPrev).toContain('gpt-5-preview');
  });

  it('dedupes dated snapshot when alias exists', () => {
    const out = curate(applyTierInference([
      { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5', provider: 'anthropic', createdAt: RECENT },
      { id: 'claude-sonnet-4-5-20250929', label: 'Sonnet 4.5 (snapshot)', provider: 'anthropic', createdAt: RECENT },
    ]), 'live');
    const ids = out.shortlist.map(m => m.id);
    expect(ids).toContain('claude-sonnet-4-5');
    expect(ids).not.toContain('claude-sonnet-4-5-20250929');
  });

  it('drops models with supportsTools=false', () => {
    const out = curate(applyTierInference([
      { id: 'gpt-4o', label: 'GPT-4o', provider: 'openai', createdAt: RECENT, supportsTools: true },
      { id: 'no-tools', label: 'No tools', provider: 'openai', createdAt: RECENT, supportsTools: false },
    ]), 'live');
    expect(out.shortlist.map(m => m.id)).toEqual(['gpt-4o']);
  });

  it('sorts flagship → balanced → reasoning → cheap', () => {
    const out = curate(applyTierInference([
      { id: 'gpt-4o-mini', label: 'mini', provider: 'openai', createdAt: RECENT },
      { id: 'o3', label: 'o3', provider: 'openai', createdAt: RECENT },
      { id: 'gpt-5', label: 'gpt-5', provider: 'openai', createdAt: RECENT },
      { id: 'gpt-4o', label: 'gpt-4o', provider: 'openai', createdAt: RECENT },
    ]), 'live');
    expect(out.shortlist.map(m => m.id)).toEqual(['gpt-5', 'gpt-4o', 'o3', 'gpt-4o-mini']);
  });

  it('reports source', () => {
    expect(curate([], 'live').source).toBe('live');
    expect(curate([], 'cache').source).toBe('cache');
  });
});
