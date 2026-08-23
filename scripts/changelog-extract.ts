#!/usr/bin/env tsx
/**
 * changelog-extract.ts — pull one release's notes out of CHANGELOG.md.
 *
 * The release workflow (`.github/workflows/release.yml`) uses this to populate
 * GitHub Release notes from the curated CHANGELOG on a `v*` tag.
 *
 * CHANGELOG.md uses `## <heading>` sections (an `## Unreleased` block plus dated
 * milestone blocks). Given a version, we return the body of the section whose
 * heading contains that version; if none matches we fall back to `## Unreleased`
 * (the accumulated pending notes are what a fresh tag ships).
 *
 * Pure logic (`extractSection`) is unit-tested; this file is the CLI wrapper.
 *
 *   npx tsx scripts/changelog-extract.ts 0.2.0            # → notes on stdout
 *   npx tsx scripts/changelog-extract.ts 0.2.0 CHANGELOG.md
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Normalize a version: strip a leading `v` and surrounding whitespace. */
export function normalizeVersion(v: string): string {
  return v.trim().replace(/^v/i, '');
}

/**
 * Extract the body under the first `## ` heading that contains `version`
 * (case-insensitive, `v` prefix ignored). Falls back to the `## Unreleased`
 * section when no heading matches. Returns the trimmed body, or '' if neither
 * is found. Only `## ` (h2) starts a section — `### ` subsections stay inside.
 */
export function extractSection(changelog: string, version: string): string {
  const wanted = normalizeVersion(version).toLowerCase();
  const lines = changelog.split('\n');

  // Collect h2 section boundaries: [headingText, startIdx].
  const sections: Array<{ heading: string; start: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^##\s+(.*)$/.exec(lines[i]);
    if (m && !lines[i].startsWith('###')) {
      sections.push({ heading: m[1].trim(), start: i });
    }
  }
  if (sections.length === 0) return '';

  const bodyOf = (idx: number): string => {
    const start = sections[idx].start + 1;
    const end = idx + 1 < sections.length ? sections[idx + 1].start : lines.length;
    return lines.slice(start, end).join('\n').trim();
  };

  // Prefer a heading that mentions the version.
  const versionIdx = sections.findIndex((s) =>
    s.heading.toLowerCase().replace(/^v/i, '').includes(wanted),
  );
  if (versionIdx !== -1) return bodyOf(versionIdx);

  // Fall back to Unreleased.
  const unreleasedIdx = sections.findIndex((s) => /^unreleased$/i.test(s.heading));
  if (unreleasedIdx !== -1) return bodyOf(unreleasedIdx);

  return '';
}

if (import.meta.main) {
  const version = process.argv[2];
  if (!version) {
    console.error('Usage: npx tsx scripts/changelog-extract.ts <version> [changelog-path]');
    process.exit(2);
  }
  const path = process.argv[3] || join(import.meta.dirname, '..', 'CHANGELOG.md');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    console.error(`Failed to read ${path}: ${(err as Error).message}`);
    process.exit(1);
  }
  const body = extractSection(raw, version);
  if (!body) {
    console.error(`No CHANGELOG section for "${version}" (and no Unreleased fallback).`);
    process.exit(1);
  }
  process.stdout.write(`${body}\n`);
}
