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
 * What the distiller's reply means. Only `none` is the model's deliberate
 * "nothing worth saving"; `truncated` and `malformed` are failures the caller
 * must surface instead of reporting them as an empty result.
 */
export type DistillOutcome =
  | { kind: 'skill'; skill: DistilledSkill }
  | { kind: 'none' }
  | { kind: 'truncated' }
  | { kind: 'malformed'; reason: string };

/**
 * Classify the distiller's reply. `finishReason` is the provider-normalized
 * CompletionResult.finishReason — 'length' means the output hit the token cap,
 * so the JSON is incomplete whatever it looks like.
 */
export function interpretDistillOutput(raw: string, finishReason?: string): DistillOutcome {
  if (finishReason === 'length') return { kind: 'truncated' };
  const jsonText = extractJsonObject(raw);
  if (!jsonText) return { kind: 'malformed', reason: 'no JSON object in the response' };
  let obj: unknown;
  try {
    obj = JSON.parse(jsonText);
  } catch {
    // Fixed reason: JSON.parse messages quote the input, which then lands in logs/tool results.
    return { kind: 'malformed', reason: 'invalid JSON' };
  }
  if (!obj || typeof obj !== 'object') return { kind: 'malformed', reason: 'response is not a JSON object' };
  const { name, description, content } = obj as Record<string, unknown>;
  if (typeof name !== 'string' || typeof description !== 'string' || typeof content !== 'string') {
    return { kind: 'malformed', reason: 'name, description and content must all be strings' };
  }
  const trimmed = { name: name.trim(), description: description.trim(), content: content.trim() };
  // The explicit "nothing to save" sentinel: every field blank.
  if (!trimmed.name && !trimmed.description && !trimmed.content) return { kind: 'none' };
  if (!trimmed.name || !trimmed.description || !trimmed.content) {
    return { kind: 'malformed', reason: 'some but not all required fields are blank' };
  }
  return { kind: 'skill', skill: trimmed };
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
