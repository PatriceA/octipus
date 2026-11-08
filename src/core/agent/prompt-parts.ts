/**
 * Split a role's base prompt for the Context inspector. Kept apart from
 * `prompt-composition.ts` because it needs the role constants, and the worker
 * that imports that module must not pull in the role registry.
 */
import { promptPart, type PromptPart } from './prompt-composition';
import { OUTPUT_FORMATTING_RULES, SECURITY_PREAMBLE } from './roles';
import { VAULT_USAGE_GUIDANCE } from './vault-guidance';

/**
 * The fixed guardrails, whatever a `before-agent-start` hook put after the
 * preamble (the persona), and the role prompt itself. Works off the real
 * constants; a prompt that does not start with them is attributed to the role
 * whole.
 */
export function splitBasePrompt(text: string, roleLabel: string): PromptPart[] {
  const parts: PromptPart[] = [];
  let rest = text;
  if (rest.startsWith(SECURITY_PREAMBLE)) {
    parts.push(promptPart('static', 'guardrails', 'Security preamble', SECURITY_PREAMBLE));
    rest = rest.slice(SECURITY_PREAMBLE.length);
    const formatting = rest.indexOf(OUTPUT_FORMATTING_RULES);
    if (formatting >= 0) {
      if (formatting > 0) parts.push(promptPart('static', 'role', 'Persona', rest.slice(0, formatting)));
      parts.push(promptPart('static', 'guardrails', 'Output formatting', OUTPUT_FORMATTING_RULES));
      rest = rest.slice(formatting + OUTPUT_FORMATTING_RULES.length);
    }
  }
  if (rest.startsWith(VAULT_USAGE_GUIDANCE)) {
    parts.push(promptPart('static', 'guardrails', 'Vault guidance', VAULT_USAGE_GUIDANCE));
    rest = rest.slice(VAULT_USAGE_GUIDANCE.length);
  }
  if (rest) parts.push(promptPart('static', 'role', roleLabel, rest));
  return parts;
}
