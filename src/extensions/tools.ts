import type { AgentContext, ToolManifest, ToolParameter, ToolPermission } from '@/core/types';
import { BaseTool } from '@/tools/base-tool';
import { getToolRegistry } from '@/tools/registry';
import type { Logger } from '@/utils/logger';
import type { ExtensionToolDef, ExtensionToolEffect } from './types';

/**
 * Tools registered by trusted extensions (`octi.registerTool`).
 *
 * Each extension gets ONE container in the tool registry, id `ext_<extension>`,
 * so its tools are called `ext_<extension>__<id>`. That prefix is the name
 * space: no built-in id starts with `ext_`, and the registry refuses an id it
 * already holds, so an extension cannot shadow a built-in, a plugin
 * (`plugin-<name>`) or another extension. The container id is also the tool
 * GROUP: roles list it in their `tools`, and lazy discovery (`list_tools` /
 * `describe_tool`) finds the tools in the long tail like any non-core group.
 *
 * Being a `BaseTool`, every call goes through the built-in middleware: the
 * `tool:before` / `tool:after` hooks, the permission check against the
 * manifest below, approval, audit and mutation recovery.
 */

/** The permission action each effect checks under, and its defaults. */
export const EFFECT_PERMISSIONS: Record<ExtensionToolEffect, ToolPermission> = {
  // `read` is one of the read-only actions (`isReadOnlyAction`): no mutation
  // journal, allowed unless a policy says otherwise.
  read: { action: 'read', description: 'Read-only extension tools', defaultLevel: 'ALLOW' },
  write: { action: 'write', description: 'Extension tools that change state', defaultLevel: 'ASK' },
  // Reaches outside the host (network, other systems). Dangerous: a broad
  // allow rule does not lift it, so it asks unless the user stored an explicit
  // policy for exactly this tool and action.
  external: { action: 'external', description: 'Extension tools with external effects', defaultLevel: 'ASK', dangerous: true },
};

const TOOL_ID_RE = /^[a-z][a-z0-9_]*$/;
/** Provider limit on a function name (Anthropic, OpenAI). */
const MAX_TOOL_NAME = 64;

/** `ext_<name>` with every run of characters outside [a-z0-9] collapsed to one `_`. */
export function extensionToolGroup(extensionName: string): string {
  const slug = extensionName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!slug) throw new Error(`extension "${extensionName}" has no name usable as a tool group`);
  return `ext_${slug}`;
}

interface RegisteredExtensionTool {
  def: ExtensionToolDef;
}

export class ExtensionToolContainer extends BaseTool {
  readonly id: string;
  readonly name: string;
  readonly version = '1.0.0';
  readonly description: string;
  private defs = new Map<string, RegisteredExtensionTool>();
  private disposed = false;

  constructor(readonly extensionName: string, private readonly logger: Logger) {
    super();
    this.id = extensionToolGroup(extensionName);
    this.name = `extension ${extensionName}`;
    this.description = `Tools registered by the "${extensionName}" extension`;
  }

  getManifest(): ToolManifest {
    const effects = new Set([...this.defs.values()].map(({ def }) => def.effect));
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      author: `extension:${this.extensionName}`,
      permissions: [...effects].map((effect) => EFFECT_PERMISSIONS[effect]),
      tools: [...this.defs.values()].map(({ def }) => ({
        name: def.id,
        description: def.description,
        parameters: manifestParameters(def.parameters),
        returns: 'Extension tool result',
      })),
    };
  }

  /** Tools are added one by one through `add`, not at initialize. */
  protected async registerTools(): Promise<void> {}

  /** Validate and add one tool. Throws on a bad definition or a duplicate id. */
  add(def: ExtensionToolDef): void {
    if (this.disposed) throw new Error(`extension "${this.extensionName}" is disposed`);
    if (typeof def?.id !== 'string' || !TOOL_ID_RE.test(def.id) || def.id.includes('__')) {
      throw new Error(`registerTool: id ${JSON.stringify(def?.id)} must be lower-case letters, digits and single underscores, starting with a letter`);
    }
    const fullName = `${this.id}__${def.id}`;
    if (fullName.length > MAX_TOOL_NAME) {
      throw new Error(`registerTool: ${fullName} is longer than ${MAX_TOOL_NAME} characters`);
    }
    if (this.defs.has(def.id)) throw new Error(`registerTool: ${fullName} is already registered`);
    if (!Object.hasOwn(EFFECT_PERMISSIONS, def.effect)) {
      throw new Error(`registerTool(${def.id}): effect must be 'read', 'write' or 'external', got ${JSON.stringify(def.effect)}`);
    }
    if (typeof def.description !== 'string' || !def.description.trim()) throw new Error(`registerTool(${def.id}): description is required`);
    if (typeof def.handler !== 'function') throw new Error(`registerTool(${def.id}): handler must be a function`);
    const parameters = def.parameters ?? { type: 'object', properties: {} };
    if (parameters.type !== 'object') throw new Error(`registerTool(${def.id}): parameters must be a JSON Schema with type "object"`);

    const action = EFFECT_PERMISSIONS[def.effect].action;
    this.defs.set(def.id, { def });
    this.registerTool(def.id, def.description, parameters, async (args, context) => {
      // A worker that started before the extension was disposed still holds
      // the handler; the extension's code must not run after its dispose.
      if (this.disposed || !this.defs.has(def.id)) return { error: `${fullName} is no longer registered` };
      return def.handler(args, toolContextFor(context));
    }, { permissionAction: action, readOnly: def.effect === 'read' });
    // Checked again up front, so a call to a removed tool is not put in
    // front of the user for approval first.
    const handler = this.tools.get(def.id)!;
    const execute = handler.execute;
    handler.execute = async (args, context) => {
      if (this.disposed || !this.defs.has(def.id)) return { error: `${fullName} is no longer registered` };
      return execute(args, context);
    };
    this.logger.info({ tool: fullName, effect: def.effect }, 'extension registered a tool');
  }

  remove(id: string): void {
    this.defs.delete(id);
    this.tools.delete(id);
  }

  get size(): number {
    return this.defs.size;
  }

  markDisposed(): void {
    this.disposed = true;
    this.defs.clear();
    this.tools.clear();
  }
}

function toolContextFor(context: AgentContext): { userId: string; sessionId: string; role?: string; workspaceId?: string | null } {
  return { userId: context.userId, sessionId: context.sessionId, role: context.role, workspaceId: context.workspaceId };
}

/** The manifest's simplified parameter list, read off the JSON Schema. */
function manifestParameters(schema: ExtensionToolDef['parameters']): Record<string, ToolParameter> {
  const out: Record<string, ToolParameter> = {};
  const props = (schema?.properties ?? {}) as Record<string, { type?: unknown; description?: unknown }>;
  const required = new Set(Array.isArray(schema?.required) ? schema.required as string[] : []);
  for (const [name, prop] of Object.entries(props)) {
    out[name] = {
      type: typeof prop?.type === 'string' ? prop.type : 'object',
      description: typeof prop?.description === 'string' ? prop.description : '',
      required: required.has(name),
    };
  }
  return out;
}

/**
 * Register the container in the tool registry. Synchronous refusal on a
 * collision: `ToolRegistry.register` claims the id before its first await.
 */
export function registerContainer(container: ExtensionToolContainer): Promise<void> {
  const registry = getToolRegistry();
  if (registry.has(container.id)) {
    throw new Error(`tool group ${container.id} is already registered (another extension, plugin or built-in); rename the extension`);
  }
  const done = registry.register(container);
  // The capability table is probed at boot, before extensions load; without a
  // row the role gate (`getToolsForRole`) would drop the group. Best effort.
  return done.then(async () => {
    try {
      const { getCapabilityService } = await import('@/capabilities/service');
      await getCapabilityService().reprobe(container.id);
    } catch { /* no database (tests, CLI): the gate is open when the cache is cold */ }
  });
}

export async function unregisterContainer(container: ExtensionToolContainer): Promise<void> {
  container.markDisposed();
  const registry = getToolRegistry();
  if (registry.get(container.id) === container) await registry.unregister(container.id);
}
