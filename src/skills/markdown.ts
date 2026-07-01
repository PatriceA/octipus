import type { Skill } from '@/db/schema/skills';
import * as yaml from 'js-yaml';

/** Portable skill shape used for export/import — no internal IDs, timestamps, or user refs */
export interface PortableSkill {
  name: string;
  category?: string;
  description: string;
  content?: string;
  principles?: string[];
  bestPractices?: string[];
  antiPatterns?: string[];
  frameworks?: string[];
}

// ---------------------------------------------------------------------------
// Export helpers
// ---------------------------------------------------------------------------

/** Strip internal fields from a skill, returning a portable object */
export function toPortableSkill(skill: Skill): PortableSkill {
  const portable: PortableSkill = {
    name: skill.name,
    category: skill.category,
    description: skill.description,
  };

  if (skill.content?.trim()) {
    portable.content = skill.content;
  }

  const principles = skill.principles as string[];
  if (principles?.length) portable.principles = principles;

  const bestPractices = skill.bestPractices as string[];
  if (bestPractices?.length) portable.bestPractices = bestPractices;

  const antiPatterns = skill.antiPatterns as string[];
  if (antiPatterns?.length) portable.antiPatterns = antiPatterns;

  const frameworks = skill.frameworks as string[];
  if (frameworks?.length) portable.frameworks = frameworks;

  return portable;
}

/** Convert a skill to a markdown document with YAML frontmatter */
export function skillToMarkdown(skill: Skill | PortableSkill): string {
  const lines: string[] = [];

  // YAML frontmatter
  lines.push('---');
  lines.push(`name: ${skill.name}`);
  lines.push(`category: ${skill.category ?? 'general'}`);
  lines.push(`description: ${skill.description}`);
  lines.push('---');
  lines.push('');

  // If there is full markdown content, use it as the body
  if (skill.content?.trim()) {
    lines.push(skill.content.trim());
    return lines.join('\n') + '\n';
  }

  // Otherwise, generate from structured fields
  const principles = (skill.principles ?? []) as string[];
  if (principles.length) {
    lines.push('## Principles');
    for (const p of principles) lines.push(`- ${p}`);
    lines.push('');
  }

  const bestPractices = (skill.bestPractices ?? []) as string[];
  if (bestPractices.length) {
    lines.push('## Best Practices');
    for (const bp of bestPractices) lines.push(`- ${bp}`);
    lines.push('');
  }

  const antiPatterns = (skill.antiPatterns ?? []) as string[];
  if (antiPatterns.length) {
    lines.push('## Anti-Patterns');
    for (const ap of antiPatterns) lines.push(`- ${ap}`);
    lines.push('');
  }

  const frameworks = (skill.frameworks ?? []) as string[];
  if (frameworks.length) {
    lines.push('## Frameworks');
    lines.push(frameworks.join(', '));
    lines.push('');
  }

  return lines.join('\n');
}

/** Convert multiple skills to a single combined markdown document */
export function skillsToMarkdown(skills: (Skill | PortableSkill)[]): string {
  return skills.map(skillToMarkdown).join('\n---\n\n');
}

// ---------------------------------------------------------------------------
// Import / parsing helpers
// ---------------------------------------------------------------------------

/** Parse YAML frontmatter from a markdown string. Returns { meta, body }. */
function parseFrontmatter(md: string): { meta: Record<string, string>; body: string } {
  const meta: Record<string, string> = {};
  const trimmed = md.trim();

  if (!trimmed.startsWith('---')) {
    return { meta, body: trimmed };
  }

  const endIndex = trimmed.indexOf('---', 3);
  if (endIndex === -1) {
    return { meta, body: trimmed };
  }

  const frontmatter = trimmed.slice(3, endIndex).trim();
  const body = trimmed.slice(endIndex + 3).trim();

  try {
    const parsed = yaml.load(frontmatter) as Record<string, any>;
    if (parsed && typeof parsed === 'object') {
      for (const [key, value] of Object.entries(parsed)) {
        if (value !== null && value !== undefined) {
          meta[key] = typeof value === 'string' ? value : String(value);
        }
      }
    }
  } catch (err) {
    // Silently ignore parse errors to fall back to an empty meta block
  }

  return { meta, body };
}

/** Extract bullet items from a section body (lines starting with - or *) */
function parseBullets(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- ') || l.startsWith('* '))
    .map((l) => l.replace(/^[-*]\s+/, ''));
}

/** Split markdown body into named sections by ## headings */
function parseSections(body: string): Map<string, string> {
  const sections = new Map<string, string>();
  const regex = /^## (.+)$/gm;
  let match: RegExpExecArray | null;
  const headings: { name: string; start: number }[] = [];

  while ((match = regex.exec(body)) !== null) {
    headings.push({ name: match[1].trim(), start: match.index + match[0].length });
  }

  for (let i = 0; i < headings.length; i++) {
    const start = headings[i].start;
    const end = i + 1 < headings.length ? headings[i + 1].start - headings[i + 1].name.length - 3 : body.length;
    sections.set(headings[i].name.toLowerCase(), body.slice(start, end).trim());
  }

  return sections;
}

/** Parse a single markdown document (with frontmatter) into a PortableSkill */
export function markdownToSkill(md: string): PortableSkill {
  const { meta, body } = parseFrontmatter(md);

  const skill: PortableSkill = {
    name: meta.name ?? 'Untitled Skill',
    category: meta.category ?? 'general',
    description: meta.description ?? '',
  };

  if (!body) return skill;

  const sections = parseSections(body);

  // If there are no recognized structured sections, treat body as raw content
  const knownSections = ['principles', 'best practices', 'anti-patterns', 'frameworks'];
  const hasStructured = knownSections.some((s) => sections.has(s));

  if (!hasStructured) {
    skill.content = body;
    return skill;
  }

  // Parse structured sections
  const principlesText = sections.get('principles');
  if (principlesText) skill.principles = parseBullets(principlesText);

  const bpText = sections.get('best practices');
  if (bpText) skill.bestPractices = parseBullets(bpText);

  const apText = sections.get('anti-patterns');
  if (apText) skill.antiPatterns = parseBullets(apText);

  const fwText = sections.get('frameworks');
  if (fwText) {
    // Frameworks may be comma-separated or bullet list
    const bullets = parseBullets(fwText);
    if (bullets.length) {
      skill.frameworks = bullets;
    } else {
      skill.frameworks = fwText
        .split(',')
        .map((f) => f.trim())
        .filter(Boolean);
    }
  }

  return skill;
}

/**
 * Parse a combined markdown document (multiple skills separated by ---) into
 * an array of PortableSkill objects.
 */
export function markdownToSkills(md: string): PortableSkill[] {
  // Split on horizontal-rule style separators that sit between skills.
  // The separator is a line that is just "---" (the same as frontmatter delimiters),
  // but it appears BETWEEN two skill documents. We split on a blank-line-surrounded "---".
  // Strategy: split on `\n---\n` that is NOT part of frontmatter.
  // We first split the entire doc into chunks by looking for the pattern:
  //   <end of content>\n---\n---\n  (end of one skill, start of next frontmatter)
  const chunks = md.split(/\n---\n\n---\n/);

  // If there's only one chunk, try splitting differently — maybe separated by just \n---\n
  if (chunks.length === 1) {
    // Try to find multiple frontmatter blocks
    const fmRegex = /^---$/gm;
    const matches: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = fmRegex.exec(md)) !== null) {
      matches.push(m.index);
    }

    // Each skill has 2 --- markers (open + close frontmatter)
    // If we have 4+ markers, we likely have multiple skills
    if (matches.length >= 4) {
      const skills: PortableSkill[] = [];
      // Group markers in pairs, and extract skill blocks
      for (let i = 0; i < matches.length - 1; i += 2) {
        // Find the next pair start
        const blockStart = matches[i];
        let blockEnd: number;
        if (i + 2 < matches.length) {
          // Next block starts at the next opening ---
          // Look for separator between this block's end and next block's start
          blockEnd = matches[i + 2];
        } else {
          blockEnd = md.length;
        }
        const block = md.slice(blockStart, blockEnd).trim();
        if (block) skills.push(markdownToSkill(block));
      }
      return skills;
    }

    // Single skill
    return [markdownToSkill(md)];
  }

  // Reconstruct each chunk — the first chunk already has its opening ---, subsequent ones don't
  const skills: PortableSkill[] = [];
  skills.push(markdownToSkill(chunks[0]));
  for (let i = 1; i < chunks.length; i++) {
    skills.push(markdownToSkill('---\n' + chunks[i]));
  }
  return skills;
}
