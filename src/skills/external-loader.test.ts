import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isExternalSkillId, loadExternalSkills } from './external-loader';

describe('External Skill Loader (filesystem, agentskills.io spec)', () => {
  let root: string;
  let home: string;
  let cwd: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'octipus-skills-'));
    home = join(root, 'home');
    cwd = join(root, 'project');
    mkdirSync(home, { recursive: true });
    mkdirSync(cwd, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('returns empty when no skill dirs exist', () => {
    const skills = loadExternalSkills({ home, cwd, configuredDirs: [], enabled: true });
    expect(skills).toEqual([]);
  });

  test('discovers a flat root *.md skill in ~/.octipus/agent/skills', () => {
    const dir = join(home, '.octipus', 'agent', 'skills');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'docker-tips.md'),
      `---\nname: Docker Tips\ncategory: devops\ndescription: Multi-stage builds keep images small.\n---\n\nUse multi-stage builds to reduce final image size.`,
    );

    const skills = loadExternalSkills({ home, cwd, configuredDirs: [], enabled: true });
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('Docker Tips');
    expect(skills[0].category).toBe('devops');
    expect(skills[0].id).toBe('external:octipus-user:docker-tips');
    expect(skills[0].isSystem).toBe(true);
    expect(skills[0].userId).toBeNull();
    expect(skills[0].content).toContain('multi-stage builds');
  });

  test('discovers a SKILL.md in a subdirectory (recursive style)', () => {
    const dir = join(cwd, '.agents', 'skills', 'pdf-tools');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---\nname: PDF Tools\ndescription: Extract text and images from PDFs.\n---\n\nRun ./scripts/extract.sh.`,
    );

    const skills = loadExternalSkills({ home, cwd, configuredDirs: [], enabled: true });
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('PDF Tools');
    expect(skills[0].id).toBe('external:agents-project:pdf-tools:SKILL');
  });

  test('does NOT pick up flat root *.md in .agents dirs (recursive-only per spec)', () => {
    const dir = join(home, '.agents', 'skills');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'flat.md'),
      `---\nname: Flat\ndescription: Should be ignored.\n---\n\nbody`,
    );

    const skills = loadExternalSkills({ home, cwd, configuredDirs: [], enabled: true });
    expect(skills).toHaveLength(0);
  });

  test('respects configured external dirs from settings', () => {
    const customDir = join(root, 'custom-skills');
    mkdirSync(customDir, { recursive: true });
    writeFileSync(
      join(customDir, 'foo.md'),
      `---\nname: Foo\ndescription: Custom dir skill.\n---\n\nbody`,
    );

    const skills = loadExternalSkills({
      home,
      cwd,
      configuredDirs: [customDir],
      enabled: true,
    });
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('Foo');
    expect(skills[0].id).toBe('external:cfg-0:foo');
  });

  test('skips files missing required frontmatter', () => {
    const dir = join(home, '.claude', 'skills');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'no-name.md'), `---\ndescription: missing name\n---\n\nbody`);
    writeFileSync(join(dir, 'no-desc.md'), `---\nname: Just A Name\n---\n\nbody`);
    writeFileSync(join(dir, 'good.md'), `---\nname: Good\ndescription: ok.\n---\n\nbody`);

    const skills = loadExternalSkills({ home, cwd, configuredDirs: [], enabled: true });
    expect(skills.map(s => s.name)).toEqual(['Good']);
  });

  test('disabled flag short-circuits all discovery', () => {
    const dir = join(home, '.octipus', 'agent', 'skills');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'a.md'),
      `---\nname: A\ndescription: a.\n---\n\nbody`,
    );

    const skills = loadExternalSkills({ home, cwd, configuredDirs: [], enabled: false });
    expect(skills).toEqual([]);
  });

  test('does not descend into a directory that already declares SKILL.md', () => {
    const dir = join(cwd, '.octipus', 'skills', 'parent');
    mkdirSync(join(dir, 'sub', 'deeper'), { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---\nname: Parent\ndescription: parent skill.\n---\n\nbody`,
    );
    writeFileSync(
      join(dir, 'sub', 'SKILL.md'),
      `---\nname: Nested\ndescription: should be ignored.\n---\n\nbody`,
    );

    const skills = loadExternalSkills({ home, cwd, configuredDirs: [], enabled: true });
    expect(skills.map(s => s.name)).toEqual(['Parent']);
  });

  test('parses Principles / Best Practices sections into structured fields', () => {
    const dir = join(home, '.pi', 'agent', 'skills');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'tdd.md'),
      [
        '---',
        'name: TDD',
        'description: Test-driven development.',
        '---',
        '',
        '## Principles',
        '- Write the test first',
        '- Red-Green-Refactor',
        '',
        '## Best Practices',
        '- One assertion per test',
        '',
      ].join('\n'),
    );

    const skills = loadExternalSkills({ home, cwd, configuredDirs: [], enabled: true });
    expect(skills).toHaveLength(1);
    expect(skills[0].principles).toEqual(['Write the test first', 'Red-Green-Refactor']);
    expect(skills[0].bestPractices).toEqual(['One assertion per test']);
  });

  test('all returned ids match isExternalSkillId predicate', () => {
    const dir = join(home, '.octipus', 'agent', 'skills');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'x.md'),
      `---\nname: X\ndescription: x.\n---\n\nbody`,
    );

    const skills = loadExternalSkills({ home, cwd, configuredDirs: [], enabled: true });
    for (const s of skills) {
      expect(isExternalSkillId(s.id)).toBe(true);
    }
  });
});
