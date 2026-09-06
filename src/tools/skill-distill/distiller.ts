import { createHash } from 'node:crypto';

/**
 * Pure helpers for the skill-distill tool — no IO, unit-testable. The tool
 * (index.ts) supplies the LLM call and DB write; this module owns the prompt,
 * the strict parse of the model's JSON, and the dedup fingerprint.
 */

export interface DistilledSkill {
  /** Short kebab-ish title. */
  name: string;
  /** One-sentence description. */
  description: string;
  /** The reusable procedure as markdown (the SKILL body). */
  content: string;
}

export const SKILL_DISTILL_SYSTEM_PROMPT = `You distill a REUSABLE skill from the material a user provides (a conversation, a document, or notes).

Extract the general *procedure* — the repeatable how-to — NOT the specific instance. Strip names, IDs, and one-off details; keep the steps, principles, and gotchas that would help next time.

Respond with ONLY a JSON object, no prose, no code fence:
{
  "name": "<short kebab-case-ish title, 2-5 words>",
  "description": "<one sentence: what this skill is for>",
  "content": "<the reusable procedure in markdown: numbered steps and/or principles>"
}

If the material contains nothing worth saving as a reusable skill, respond with exactly: {"name":"","description":"","content":""}`;

/** Extract a JSON object from raw model output (tolerates a ```json fence or surrounding prose). */
function extractJsonObject(raw: string): string | null {
  const fenced = raw.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
  if (fenced) return fenced[1];
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end > start) return raw.slice(start, end + 1);
  return null;
}

/**
 * Strictly parse the distiller's JSON into a DistilledSkill. Returns null when
 * the output is unparseable OR when the model signalled "nothing worth saving"
 * (all fields blank) — the caller then declines to create a proposal (fail
 * loud: never persist an empty skill).
 */
export function parseDistilledSkill(raw: string): DistilledSkill | null {
  const jsonText = extractJsonObject(raw);
  if (!jsonText) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const { name, description, content } = obj as Record<string, unknown>;
  if (typeof name !== 'string' || typeof description !== 'string' || typeof content !== 'string') {
    return null;
  }
  const trimmed = { name: name.trim(), description: description.trim(), content: content.trim() };
  // The explicit "nothing to save" sentinel — or any blank required field.
  if (!trimmed.name || !trimmed.description || !trimmed.content) return null;
  return trimmed;
}

/**
 * Normalized form of a skill name: lowercase, punctuation collapsed to single
 * dashes. `Token Rotation Procedure` and `token-rotation-procedure` are the
 * same skill; before this they hashed differently and both got filed.
 */
export function normalizeSkillName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Stable dedup fingerprint for a distilled skill. Keyed on the normalized name
 * so re-distilling the same procedure collides rather than spawning duplicate
 * proposals. Name variants that survive normalization ("vault-token-rotation"
 * vs "secure-credential-rotation") are caught by the embedding check instead.
 */
export function skillFingerprint(userId: string, name: string): string {
  // A name of pure punctuation normalizes to '' — falling back to the raw
  // lowercased name keeps two such names from hashing to the same skill.
  const key = normalizeSkillName(name) || name.trim().toLowerCase();
  return createHash('sha256').update(`${userId}:${key}`).digest('hex');
}

/** Cosine similarity above which two skills are the same procedure, differently named. */
export const NEAR_DUPLICATE_SIMILARITY = 0.85;

/** Cosine similarity of two equal-length vectors. 0 when either is degenerate. */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** The text a skill is compared by — name and description, not the body. */
export function similarityText(skill: { name: string; description: string }): string {
  return `${skill.name}\n${skill.description}`;
}
