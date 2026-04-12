import { describe, test, expect } from 'bun:test';
import {
  skillToMarkdown,
  markdownToSkill,
  markdownToSkills,
  toPortableSkill,
  type PortableSkill,
} from './markdown';

describe('Skill Markdown (Unit)', () => {
  // ─── Test data ───────────────────────────────────────────────────

  const structuredSkill: PortableSkill = {
    name: 'Test Driven Development',
    category: 'qa',
    description: 'Write tests before implementation',
    principles: ['Write the test first', 'Red-Green-Refactor', 'Keep tests small'],
    bestPractices: ['One assertion per test', 'Use descriptive test names'],
    antiPatterns: ['Testing implementation details', 'Flaky tests'],
    frameworks: ['Jest', 'Vitest', 'Bun Test'],
  };

  const contentSkill: PortableSkill = {
    name: 'Docker Best Practices',
    category: 'devops',
    description: 'Container best practices',
    content: '# Docker Tips\n\nUse multi-stage builds to reduce image size.',
  };

  const minimalSkill: PortableSkill = {
    name: 'Minimal Skill',
    description: 'A skill with no extra fields',
  };

  // ─── skillToMarkdown ────────────────────────────────────────────

  describe('skillToMarkdown', () => {
    test('produces valid markdown with frontmatter', () => {
      const md = skillToMarkdown(structuredSkill);

      expect(md).toContain('---');
      expect(md).toContain('name: Test Driven Development');
      expect(md).toContain('category: qa');
      expect(md).toContain('description: Write tests before implementation');
    });

    test('frontmatter is delimited by --- markers', () => {
      const md = skillToMarkdown(structuredSkill);
      const lines = md.split('\n');

      expect(lines[0]).toBe('---');
      // Find closing ---
      const closingIndex = lines.indexOf('---', 1);
      expect(closingIndex).toBeGreaterThan(0);
    });

    test('includes principles section', () => {
      const md = skillToMarkdown(structuredSkill);

      expect(md).toContain('## Principles');
      expect(md).toContain('- Write the test first');
      expect(md).toContain('- Red-Green-Refactor');
      expect(md).toContain('- Keep tests small');
    });

    test('includes best practices section', () => {
      const md = skillToMarkdown(structuredSkill);

      expect(md).toContain('## Best Practices');
      expect(md).toContain('- One assertion per test');
      expect(md).toContain('- Use descriptive test names');
    });

    test('includes anti-patterns section', () => {
      const md = skillToMarkdown(structuredSkill);

      expect(md).toContain('## Anti-Patterns');
      expect(md).toContain('- Testing implementation details');
      expect(md).toContain('- Flaky tests');
    });

    test('includes frameworks section', () => {
      const md = skillToMarkdown(structuredSkill);

      expect(md).toContain('## Frameworks');
      expect(md).toContain('Jest, Vitest, Bun Test');
    });

    test('uses content body when content field is set', () => {
      const md = skillToMarkdown(contentSkill);

      expect(md).toContain('name: Docker Best Practices');
      expect(md).toContain('# Docker Tips');
      expect(md).toContain('Use multi-stage builds');
      // Should NOT have structured sections
      expect(md).not.toContain('## Principles');
    });

    test('defaults category to general when not set', () => {
      const md = skillToMarkdown(minimalSkill);

      expect(md).toContain('category: general');
    });

    test('handles skill with empty arrays', () => {
      const skill: PortableSkill = {
        name: 'Empty',
        description: 'No content',
        principles: [],
        bestPractices: [],
        antiPatterns: [],
        frameworks: [],
      };

      const md = skillToMarkdown(skill);

      // Should have frontmatter but no section headings
      expect(md).toContain('name: Empty');
      expect(md).not.toContain('## Principles');
      expect(md).not.toContain('## Best Practices');
    });
  });

  // ─── markdownToSkill ────────────────────────────────────────────

  describe('markdownToSkill', () => {
    test('parses frontmatter correctly', () => {
      const md = `---
name: My Skill
category: security
description: A security skill
---

## Principles
- Least privilege
- Defense in depth`;

      const skill = markdownToSkill(md);

      expect(skill.name).toBe('My Skill');
      expect(skill.category).toBe('security');
      expect(skill.description).toBe('A security skill');
    });

    test('parses structured sections', () => {
      const md = `---
name: Code Review
category: review
description: Code review practices
---

## Principles
- Review for correctness
- Review for readability

## Best Practices
- Use checklists
- Keep reviews small

## Anti-Patterns
- Rubber stamping
- Nitpicking style only

## Frameworks
GitHub PR Reviews, GitLab MR`;

      const skill = markdownToSkill(md);

      expect(skill.principles).toBeDefined();
      expect(skill.principles!.length).toBe(2);
      expect(skill.principles).toContain('Review for correctness');

      expect(skill.bestPractices).toBeDefined();
      expect(skill.bestPractices!.length).toBe(2);
      expect(skill.bestPractices).toContain('Use checklists');

      expect(skill.antiPatterns).toBeDefined();
      expect(skill.antiPatterns!.length).toBe(2);
      expect(skill.antiPatterns).toContain('Rubber stamping');

      expect(skill.frameworks).toBeDefined();
      expect(skill.frameworks!.length).toBe(2);
      expect(skill.frameworks).toContain('GitHub PR Reviews');
      expect(skill.frameworks).toContain('GitLab MR');
    });

    test('treats body as content when no structured sections found', () => {
      const md = `---
name: Free-form
category: general
description: A free-form skill
---

This is just some markdown content.

It has no structured sections.`;

      const skill = markdownToSkill(md);

      expect(skill.content).toBeDefined();
      expect(skill.content).toContain('This is just some markdown content');
      expect(skill.principles).toBeUndefined();
    });

    test('defaults name to Untitled Skill when missing', () => {
      const md = `---
description: No name here
---

Some content`;

      const skill = markdownToSkill(md);

      expect(skill.name).toBe('Untitled Skill');
    });

    test('defaults category to general when missing', () => {
      const md = `---
name: No Category
description: Test
---

Some content`;

      const skill = markdownToSkill(md);

      expect(skill.category).toBe('general');
    });

    test('handles markdown without frontmatter', () => {
      const md = 'Just plain text with no frontmatter';

      const skill = markdownToSkill(md);

      expect(skill.name).toBe('Untitled Skill');
      expect(skill.content).toBe('Just plain text with no frontmatter');
    });

    test('handles empty body', () => {
      const md = `---
name: Empty Body
category: coding
description: No body
---`;

      const skill = markdownToSkill(md);

      expect(skill.name).toBe('Empty Body');
      expect(skill.content).toBeUndefined();
      expect(skill.principles).toBeUndefined();
    });
  });

  // ─── Round-trip ─────────────────────────────────────────────────

  describe('round-trip: skill -> markdown -> skill', () => {
    test('preserves structured data through round-trip', () => {
      const md = skillToMarkdown(structuredSkill);
      const parsed = markdownToSkill(md);

      expect(parsed.name).toBe(structuredSkill.name);
      expect(parsed.category).toBe(structuredSkill.category);
      expect(parsed.description).toBe(structuredSkill.description);
      expect(parsed.principles).toEqual(structuredSkill.principles);
      expect(parsed.bestPractices).toEqual(structuredSkill.bestPractices);
      expect(parsed.antiPatterns).toEqual(structuredSkill.antiPatterns);
      expect(parsed.frameworks).toEqual(structuredSkill.frameworks);
    });

    test('preserves content-based skill through round-trip', () => {
      const md = skillToMarkdown(contentSkill);
      const parsed = markdownToSkill(md);

      expect(parsed.name).toBe(contentSkill.name);
      expect(parsed.category).toBe(contentSkill.category);
      expect(parsed.description).toBe(contentSkill.description);
      expect(parsed.content).toContain('Docker Tips');
      expect(parsed.content).toContain('multi-stage builds');
    });

    test('preserves minimal skill through round-trip', () => {
      const md = skillToMarkdown(minimalSkill);
      const parsed = markdownToSkill(md);

      expect(parsed.name).toBe(minimalSkill.name);
      expect(parsed.description).toBe(minimalSkill.description);
    });
  });

  // ─── markdownToSkills (multi-skill documents) ───────────────────

  describe('markdownToSkills', () => {
    test('parses a single skill document', () => {
      const md = `---
name: Single Skill
category: coding
description: Just one
---

## Principles
- Be thorough`;

      const skills = markdownToSkills(md);

      expect(skills.length).toBe(1);
      expect(skills[0].name).toBe('Single Skill');
    });

    test('handles multi-skill document with separator', () => {
      const md = `---
name: Skill One
category: coding
description: First skill
---

## Principles
- First principle

---

---
name: Skill Two
category: security
description: Second skill
---

## Principles
- Second principle`;

      const skills = markdownToSkills(md);

      expect(skills.length).toBe(2);
      expect(skills[0].name).toBe('Skill One');
      expect(skills[1].name).toBe('Skill Two');
    });

    test('handles multi-skill document with multiple frontmatter blocks', () => {
      const md = `---
name: Alpha
category: coding
description: Alpha skill
---

## Principles
- Alpha principle

---
name: Beta
category: devops
description: Beta skill
---

## Principles
- Beta principle`;

      const skills = markdownToSkills(md);

      expect(skills.length).toBe(2);
      expect(skills[0].name).toBe('Alpha');
      expect(skills[1].name).toBe('Beta');
    });

    test('returns empty principles for skill with no body sections', () => {
      const md = `---
name: Empty
category: coding
description: No body
---`;

      const skills = markdownToSkills(md);

      expect(skills.length).toBe(1);
      expect(skills[0].principles).toBeUndefined();
    });
  });

  // ─── toPortableSkill ────────────────────────────────────────────

  describe('toPortableSkill', () => {
    test('strips internal fields from a skill', () => {
      // Simulate a full DB Skill record
      const dbSkill = {
        id: 'uuid-123',
        name: 'DB Skill',
        category: 'data',
        description: 'A database skill',
        content: '',
        principles: ['Principle 1'],
        bestPractices: ['BP 1'],
        antiPatterns: ['AP 1'],
        frameworks: ['Framework 1'],
        userId: 'user-1',
        isBuiltIn: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any;

      const portable = toPortableSkill(dbSkill);

      expect(portable.name).toBe('DB Skill');
      expect(portable.category).toBe('data');
      expect(portable.description).toBe('A database skill');
      expect(portable.principles).toEqual(['Principle 1']);
      expect(portable.bestPractices).toEqual(['BP 1']);
      expect(portable.antiPatterns).toEqual(['AP 1']);
      expect(portable.frameworks).toEqual(['Framework 1']);

      // Should NOT have internal fields
      expect((portable as any).id).toBeUndefined();
      expect((portable as any).userId).toBeUndefined();
      expect((portable as any).createdAt).toBeUndefined();
      expect((portable as any).updatedAt).toBeUndefined();
    });

    test('omits empty content', () => {
      const dbSkill = {
        name: 'No Content',
        category: 'coding',
        description: 'Test',
        content: '   ',
        principles: null,
        bestPractices: null,
        antiPatterns: null,
        frameworks: null,
      } as any;

      const portable = toPortableSkill(dbSkill);

      expect(portable.content).toBeUndefined();
      expect(portable.principles).toBeUndefined();
      expect(portable.bestPractices).toBeUndefined();
    });

    test('includes content when non-empty', () => {
      const dbSkill = {
        name: 'With Content',
        category: 'coding',
        description: 'Test',
        content: 'Some markdown body',
        principles: null,
        bestPractices: null,
        antiPatterns: null,
        frameworks: null,
      } as any;

      const portable = toPortableSkill(dbSkill);

      expect(portable.content).toBe('Some markdown body');
    });
  });
});
