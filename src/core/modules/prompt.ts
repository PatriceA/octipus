import { isCapabilityOn } from '@/core/capabilities/gates';
import { type Capability, isCapability } from '@/shared/capabilities';
import { isModuleOn } from './registry';

/**
 * Prompt text that belongs to a module (docs/MODULES.md) is marked in the
 * prompt files, and left out while the module is off, so an agent is never
 * told about tools or pages it does not have:
 *
 *   - `artifacts` — live dashboards. <!-- module:artifacts -->
 *     A line ending in the marker: the line goes when the module is off.
 *
 *   <!-- module:artifacts -->
 *   ...
 *   <!-- /module -->
 *     A marker on a line of its own opens a block that the closing marker
 *     ends: the block goes when the module is off.
 *
 * `module:!<id>` marks the text used instead while the module is off.
 * The markers themselves never reach a model.
 */
const MARK = '(?:module|cap):!?[a-z0-9-]+';
const LINE = new RegExp(`^(.*?)\\s*<!--\\s*(${MARK})\\s*-->\\s*$`);
const OPEN = new RegExp(`^\\s*<!--\\s*(${MARK})\\s*-->\\s*$`);
const CLOSE = /^\s*<!--\s*\/(?:module|cap)\s*-->\s*$/;

/**
 * Text that belongs to a module or needs a capability is left out while the
 * module is off or the capability is not configured. Capability markers
 * (`<!-- cap:embedding -->`, `<!-- cap:!see -->`, closed by `<!-- /cap -->`)
 * work exactly like module markers (src/core/capabilities/gates.ts).
 */
export function withoutOffModules(
  prompt: string,
  isOn: (id: string) => boolean = isModuleOn,
  capOn: (id: Capability) => boolean = isCapabilityOn,
): string {
  if (!prompt.includes('<!--')) return prompt;
  const holds = (marker: string): boolean => {
    const [kind, rawId] = marker.split(':') as ['module' | 'cap', string];
    const negated = rawId.startsWith('!');
    const id = negated ? rawId.slice(1) : rawId;
    // A marker naming no known capability never holds, negated or not: a typo
    // hides its text instead of leaking it.
    if (kind === 'cap' && !isCapability(id)) return false;
    const value = kind === 'module' ? isOn(id) : capOn(id as Capability);
    return negated ? !value : value;
  };
  const out: string[] = [];
  /** The markers of the blocks we are in; a block whose marker does not hold hides its lines. */
  const open: string[] = [];
  for (const line of prompt.split('\n')) {
    const opened = OPEN.exec(line);
    if (opened) { open.push(opened[1]); continue; }
    if (CLOSE.test(line)) { open.pop(); continue; }
    if (open.some((marker) => !holds(marker))) continue;
    const marked = LINE.exec(line);
    if (marked) {
      if (holds(marked[2])) out.push(marked[1]);
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}
