import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { skillRepository } from '@/db/repositories/skill-repository';
import type { Skill } from '@/db/schema/skills';
import { DEFAULT_REVIEW_DAYS, DEFAULT_STALE_DAYS, runSkillCurator } from './curator';

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: overrides.id ?? 'skill-1',
    name: overrides.name ?? 'Skill 1',
    category: 'general',
    description: 'd',
    content: '',
    principles: [],
    bestPractices: [],
    antiPatterns: [],
    frameworks: [],
    isSystem: false,
    userId: null,
    orgId: null,
    triggers: [],
    descriptionEmbedding: null,
    descriptionHash: null,
    alwaysInject: false,
    lastUsedAt: overrides.lastUsedAt ?? null,
    usageCount: overrides.usageCount ?? 0,
    archivedAt: overrides.archivedAt ?? null,
    curationNotes: overrides.curationNotes ?? null,
    createdAt: overrides.createdAt ?? new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
    updatedAt: overrides.updatedAt ?? new Date(),
  } as Skill;
}

const realFindStale = skillRepository.findStale.bind(skillRepository);
const realArchive = skillRepository.archive.bind(skillRepository);

describe('runSkillCurator', () => {
  beforeEach(() => {
    skillRepository.findStale = vi.fn(async () => []);
    skillRepository.archive = vi.fn(async () => undefined);
  });

  afterEach(() => {
    skillRepository.findStale = realFindStale;
    skillRepository.archive = realArchive;
  });

  test('empty stale list → empty report, no writes', async () => {
    const report = await runSkillCurator();
    expect(report.inspected).toBe(0);
    expect(report.flagged).toEqual([]);
    expect(report.archived).toEqual([]);
  });

  test('archives skills older than the archive cutoff', async () => {
    const ancient = new Date(Date.now() - (DEFAULT_STALE_DAYS + 5) * 86_400_000);
    skillRepository.findStale = vi.fn(async () => [
      makeSkill({ id: 's-ancient', lastUsedAt: ancient }),
    ]);
    const calls: Array<{ id: string; note?: string }> = [];
    skillRepository.archive = vi.fn(async (id: string, note?: string) => {
      calls.push({ id, note });
      return undefined;
    });
    const report = await runSkillCurator();
    expect(report.archived).toHaveLength(1);
    expect(report.archived[0].skill.id).toBe('s-ancient');
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe('s-ancient');
    expect(calls[0].note).toMatch(/auto-curator/);
  });

  test('only flags (does not archive) skills between review and archive cutoffs', async () => {
    // 45 days unused — past review (30d) but before archive (90d).
    const recent = new Date(Date.now() - 45 * 86_400_000);
    skillRepository.findStale = vi.fn(async () => [
      makeSkill({ id: 's-flag', lastUsedAt: recent }),
    ]);
    const report = await runSkillCurator();
    expect(report.flagged).toHaveLength(1);
    expect(report.flagged[0].skill.id).toBe('s-flag');
    expect(report.archived).toEqual([]);
  });

  test('never-used skills are archived when older than the archive cutoff', async () => {
    skillRepository.findStale = vi.fn(async () => [
      makeSkill({ id: 's-never', lastUsedAt: null }),
    ]);
    const report = await runSkillCurator();
    expect(report.archived).toHaveLength(1);
    expect(report.archived[0].reason).toMatch(/never used/);
  });

  test('applyArchive=false produces a would-archive flag instead of writing', async () => {
    const ancient = new Date(Date.now() - 200 * 86_400_000);
    skillRepository.findStale = vi.fn(async () => [
      makeSkill({ id: 's-dry', lastUsedAt: ancient }),
    ]);
    let archiveCalls = 0;
    skillRepository.archive = vi.fn(async () => { archiveCalls++; return undefined; });
    const report = await runSkillCurator({ applyArchive: false });
    expect(report.archived).toEqual([]);
    expect(report.flagged).toHaveLength(1);
    expect(report.flagged[0].reason).toMatch(/would-archive/);
    expect(archiveCalls).toBe(0);
  });

  test('respects custom thresholds', async () => {
    // 10 days old, archiveAfterDays=5 — should archive.
    skillRepository.findStale = vi.fn(async () => [
      makeSkill({ id: 's-custom', lastUsedAt: new Date(Date.now() - 10 * 86_400_000) }),
    ]);
    const report = await runSkillCurator({
      archiveAfterDays: 5,
      reviewAfterDays: 1,
    });
    expect(report.archived).toHaveLength(1);
  });

  test('DEFAULT_REVIEW_DAYS < DEFAULT_STALE_DAYS by contract', () => {
    expect(DEFAULT_REVIEW_DAYS).toBeLessThan(DEFAULT_STALE_DAYS);
  });
});
