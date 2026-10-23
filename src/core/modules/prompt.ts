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
const LINE = /^(.*?)\s*<!--\s*module:(!?[a-z0-9-]+)\s*-->\s*$/;
const OPEN = /^\s*<!--\s*module:(!?[a-z0-9-]+)\s*-->\s*$/;
const CLOSE = /^\s*<!--\s*\/module\s*-->\s*$/;

export function withoutOffModules(prompt: string, isOn: (id: string) => boolean = isModuleOn): string {
  if (!prompt.includes('<!--')) return prompt;
  const on = (marker: string) => (marker.startsWith('!') ? !isOn(marker.slice(1)) : isOn(marker));
  const out: string[] = [];
  /** The modules of the blocks we are in; a block of an off module hides its lines. */
  const open: string[] = [];
  for (const line of prompt.split('\n')) {
    const opened = OPEN.exec(line);
    if (opened) { open.push(opened[1]); continue; }
    if (CLOSE.test(line)) { open.pop(); continue; }
    if (open.some((id) => !on(id))) continue;
    const marked = LINE.exec(line);
    if (marked) {
      if (on(marked[2])) out.push(marked[1]);
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}
