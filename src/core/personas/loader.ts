import { resolve } from 'path';
import { coreLogger } from '@/utils/logger';
import { Persona, type Persona as PersonaT } from './types';
import { parseYaml } from './yaml';
import { fileAt, globFiles } from '@/utils/fs-file';

/**
 * Locate the personas directory. Personas live at the repo root in
 * `personas/`. In dev the cwd is the repo root; in compiled
 * deployments the binary copies the dir alongside the executable —
 * fall back to looking relative to `import.meta.dirname` for that case.
 */
export function getPersonasDir(): string {
  const fromCwd = resolve(process.cwd(), 'personas');
  return fromCwd;
}

/**
 * Load a single persona YAML file from disk and validate it.
 * Throws if the file is missing or fails schema validation — there
 * is no silent fallback (DESIGN.md fail-loud rule).
 */
export async function loadPersonaFile(filePath: string): Promise<PersonaT> {
  const file = fileAt(filePath);
  if (!(await file.exists())) {
    throw new Error(`Persona file not found: ${filePath}`);
  }
  const text = await file.text();
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new Error(`Failed to parse persona YAML at ${filePath}: ${(err as Error).message}`);
  }

  const parsed = Persona.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map(i => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid persona at ${filePath}:\n${issues}`);
  }
  return parsed.data;
}

/**
 * Load every `*.yaml` in the personas/ directory. Returns the list
 * in load order. Logs and skips files that fail to parse so a single
 * broken preset can't take down the whole registry — but the base
 * `octipus.yaml` must always load (registry enforces this).
 */
export async function loadAllPersonas(dir?: string): Promise<PersonaT[]> {
  const personasDir = dir ?? getPersonasDir();
  const out: PersonaT[] = [];
  try {
    for await (const file of globFiles('*.yaml', { cwd: personasDir })) {
      try {
        out.push(await loadPersonaFile(file));
      } catch (err) {
        coreLogger.warn({ err, file }, 'persona load failed — skipping');
      }
    }
  } catch (err) {
    coreLogger.warn({ err, personasDir }, 'persona directory scan failed');
  }
  return out;
}
