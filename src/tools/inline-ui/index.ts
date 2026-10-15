/**
 * Interactive answers (docs/plans/inline-ui-spec.md). The agent writes them as
 * `octi-ui` fenced blocks in its reply, not through a tool; this tool group
 * exists for two things:
 *
 * - `source` returns the source of an earlier block of this conversation, so
 *   "make the bars blue" can start from it (replies keep only a marker);
 * - its `render` permission action is the kill switch: a stored DENY turns
 *   interactive answers off for the user (root-runner checks it).
 */
import { ToolNotExecutedError } from '@/core/tool-execution-error';
import type { ToolManifest } from '@/core/types';
import { inlineUiRepository } from '@/db/repositories/inline-ui-repository';
import { BaseTool, createParameterSchema } from '../base-tool';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The block as the model writes it again: styles, markup, script. */
export function inlineUiSourceBody(block: { css: string; html: string; js: string }): string {
  return [
    block.css ? `<style>\n${block.css}\n</style>` : '',
    block.html,
    block.js ? `<script>\n${block.js}\n</script>` : '',
  ].filter(Boolean).join('\n');
}

export class InlineUiTool extends BaseTool {
  readonly id = 'inline-ui';
  readonly name = 'Interactive answers';
  readonly version = '1.0.0';
  readonly description = 'Interactive answers in replies (web app): read the source of an earlier one to change it.';

  getManifest(): ToolManifest {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      permissions: [
        { action: 'render', description: 'Show interactive answers (sandboxed HTML/CSS/JS) in replies in the web app', defaultLevel: 'ALLOW' },
        { action: 'read', description: 'Read the source of an interactive answer in this conversation', defaultLevel: 'ALLOW' },
      ],
      tools: [
        { name: 'source', description: 'Source of an earlier interactive answer in this conversation', parameters: {}, returns: '{ id, title, height, body }' },
      ],
    };
  }

  protected async registerTools(): Promise<void> {
    this.registerTool(
      'source',
      'Return the source of an earlier interactive answer of this conversation (shown in replies as [[octi-ui:<id>|<title>]]), ready to edit and write again as a new ```octi-ui block.',
      createParameterSchema({
        id: { type: 'string', description: 'The id from the [[octi-ui:<id>|…]] marker', required: true },
      }),
      async (args, context) => {
        if (!context.root || context.metadata?.inlineUiOffered !== true) {
          throw new ToolNotExecutedError(this.id, 'Interactive answers are not available in this conversation.');
        }
        const id = String(args.id ?? '').trim().toLowerCase();
        if (!UUID_RE.test(id)) throw new ToolNotExecutedError(this.id, `"${args.id}" is not an interactive answer id (a UUID from a [[octi-ui:<id>|…]] marker).`);
        const block = await inlineUiRepository.getInSession(id, context.sessionId);
        if (!block) throw new ToolNotExecutedError(this.id, `No interactive answer ${id} in this conversation.`);
        return { id: block.id, title: block.title, height: block.heightHint, body: inlineUiSourceBody(block) };
      },
      { permissionAction: 'read', readOnly: true, injectSecrets: false },
    );
  }
}

export const inlineUiTool = new InlineUiTool();
