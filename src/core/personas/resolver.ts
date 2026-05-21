import { coreLogger } from '@/utils/logger';
import { getPersonaProfileRepository, PersonaProfileRepository } from './repository';
import { getPersonaRegistry } from './registry';
import type {
  NarrationTemplates,
  Persona,
  PersonaNarration,
  PersonaTone,
  ResolvedPersona,
} from './types';

/**
 * Resolve the active persona for a user.
 *
 * Order:
 *   1. Read the user's assistant profile (category='assistant').
 *   2. Look up the preset by `preset_id` from the registry. Fall back
 *      to the `octipus` default if the preset disappeared.
 *   3. Apply per-user overrides: name, tone, narration, pronouns,
 *      free-form extras.
 *
 * Returns a fully-rendered `ResolvedPersona` whose `promptBlock` is
 * already interpolated (no `{{name}}` placeholders left) so callers
 * just prepend it.
 *
 * Throws only if the registry has not been initialized — that's a
 * programmer error, not a user-visible failure. Profile-table errors
 * are logged and the function returns the base persona instead.
 */
export async function resolvePersonaForUser(userId: string): Promise<ResolvedPersona> {
  const registry = getPersonaRegistry();
  await registry.ensureLoaded();
  const base = registry.getDefault();

  let preset: Persona = base;
  let userName = base.name;
  let tone: PersonaTone = base.tone;
  let narration: PersonaNarration = base.defaults.narration;
  let pronouns = base.pronouns;
  let userFacts: string[] = [];
  let profileId: string | undefined;

  try {
    const profile = await getPersonaProfileRepository().findForUser(userId);
    if (profile) {
      profileId = profile.id;
      userName = profile.name;
      const fields = PersonaProfileRepository.toFields(profile);
      const presetByUser = registry.get(fields.presetId);
      if (presetByUser) {
        preset = presetByUser;
      } else {
        coreLogger.warn(
          { userId, presetId: fields.presetId },
          'user persona preset not found in registry — falling back to base',
        );
      }
      // Per-user overrides take precedence over preset defaults.
      tone = (preset.tone === fields.tone ? preset.tone : (fields.tone as PersonaTone)) || preset.tone;
      narration = (fields.narration as PersonaNarration) || preset.defaults.narration;
      pronouns = fields.pronouns || preset.pronouns;
      userFacts = fields.extras;
    }
  } catch (err) {
    coreLogger.warn({ err, userId }, 'persona resolve: profile lookup failed — using base');
  }

  const promptBlock = renderPromptBlock({
    preset,
    name: userName,
    pronouns,
    tone,
    userFacts,
  });

  return {
    id: preset.id,
    profileId,
    name: userName,
    pronouns,
    tone,
    promptBlock,
    narration,
    narrationTemplates: preset.narration_templates,
    signaturePhrases: preset.signature_phrases,
    userFacts,
    presetId: preset.id,
  };
}

/**
 * Substitute `{{name}}` (and a few other placeholders) inside the
 * preset's prompt block, then append a normalized header + the user's
 * free-form facts. Result is ready to be prepended to the role prompt.
 */
function renderPromptBlock(opts: {
  preset: Persona;
  name: string;
  pronouns: string;
  tone: PersonaTone;
  userFacts: string[];
}): string {
  const { preset, name, pronouns, tone, userFacts } = opts;
  // The preset's `persona_prompt` may itself mention the default name
  // ("Octipus"). Substitute that with the user-chosen name so the rest
  // of the voice rules read coherently after a rename.
  const renderedPrompt = preset.persona_prompt
    .replaceAll('{{name}}', name)
    .replaceAll('{{pronouns}}', pronouns)
    .replaceAll('{{tone}}', tone)
    // The base preset talks about itself as "Octipus" everywhere. If
    // the user renamed, swap the word — but only when it appears as a
    // standalone capitalized identity reference, not inside compound
    // words like "octipus.yaml".
    .replaceAll(/\bOctipus\b/g, name);

  let block = '--- PERSONA ---\n';
  block += renderedPrompt.trim();

  if (userFacts.length > 0) {
    block += '\n\nADDITIONAL FACTS THE USER HAS SET ABOUT YOU:\n';
    for (const f of userFacts) block += `- ${f.trim()}\n`;
  }

  block += '\n--- END PERSONA ---\n\n';
  return block;
}

/**
 * Render a narration line for the active swarm event. Returns null
 * when the persona has `narration: off` or no template for that
 * event type.
 */
export function renderNarration(
  persona: ResolvedPersona,
  template: keyof NarrationTemplates,
  vars: Record<string, string | number>,
): string | null {
  if (persona.narration === 'off') return null;
  const raw = persona.narrationTemplates[template];
  if (!raw) return null;
  return raw.replaceAll(/\{\{(\w+)\}\}/g, (_, key) => {
    if (key === 'name') return persona.name;
    if (key in vars) return String(vars[key]);
    return '';
  }).trim();
}
