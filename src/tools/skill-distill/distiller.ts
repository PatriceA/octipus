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
 * Stable dedup fingerprint for a distilled skill. Keyed on the normalized name
 * so re-distilling the same procedure updates/collides rather than spawning
 * duplicate proposals (mirrors the auto-extension proposal fingerprinting).
 */
export function skillFingerprint(userId: string, name: string): string {
  return createHash('sha256').update(`${userId}:${name.trim().toLowerCase()}`).digest('hex');
}
