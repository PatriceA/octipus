import { raiseSessionLevel } from '@/core/protection/session-level';
import { isProtectedEntity, PROTECTED_ENTITIES, ProtectionLevelError, setProtectionLevel } from '@/core/protection/levels';
import type { ToolManifest } from '@/core/types';
import { reposFor } from '@/db/repositories/content';
import { PROTECTION_LEVEL_LABELS } from '@/shared/protection';
import { BaseTool, createParameterSchema } from '../base-tool';

/**
 * Protection levels (docs/PROTECTION-LEVELS.md). An agent that finds content
 * more sensitive than its level says (health data in a document, a salary
 * in a record) raises the level; only a person can lower one.
 */
export class ProtectionTool extends BaseTool {
  readonly id = 'protection';
  readonly name = 'Protection levels';
  readonly version = '1.0.0';
  readonly description = 'Raise the protection level of a document, case, record or mail message when it holds more sensitive data than its level says.';

  getManifest(): ToolManifest {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      permissions: [
        { action: 'raise', description: 'Raise the protection level of content (never lower it)', defaultLevel: 'ALLOW' },
      ],
      tools: [
        { name: 'raise_protection_level', description: 'Raise the protection level of a document, case, record or mail message', parameters: {}, returns: 'The change' },
      ],
    };
  }

  protected async registerTools(): Promise<void> {
    this.registerTool(
      'raise_protection_level',
      'Raise the protection level of a document, case, record or mail message. Levels: 1 public, 2 internal, 3 confidential (personal data), 4 strictly confidential (health, HR, legal, special categories). Raise only; only a person can lower a level.',
      createParameterSchema({
        kind: { type: 'string', description: 'What it is', enum: [...PROTECTED_ENTITIES], required: true },
        id: { type: 'string', description: 'Its id', required: true },
        level: { type: 'number', description: 'The new level, 1-4, at least the current one', enum: [1, 2, 3, 4], required: true },
        reason: { type: 'string', description: 'Why, in a few words (for the owner)' },
      }),
      async (args, context) => {
        if (!isProtectedEntity(args.kind)) throw new Error(`Unknown kind: ${String(args.kind)}`);
        try {
          const change = await setProtectionLevel(reposFor(context), args.kind, String(args.id), Number(args.level), 'agent');
          if (!change) throw new Error(`${args.kind} not found`);
          // The agent found the content more sensitive: so is this conversation.
          raiseSessionLevel(context.sessionId, change.effective);
          return { ...change, label: PROTECTION_LEVEL_LABELS[change.effective] };
        } catch (err) {
          if (err instanceof ProtectionLevelError) throw new Error(err.message);
          throw err;
        }
      },
      { requiresPermission: true, permissionAction: 'raise' },
    );
  }
}

export const protectionTool = new ProtectionTool();
