/**
 * `capabilities` — the agent's answer to "what can you actually do?"
 *
 * Octipus knew all of this and could not say it. `list_tools`/`describe_tool`
 * (tool-discovery.ts) enumerate the long tail, but they are built only on the
 * lazy path — `provider === 'ollama'` — so on every remote provider the root
 * agent was handed a tool list it had no way to enumerate. And nothing at all,
 * on any path, let it see the mounted MCP servers, the loadable skills, the
 * experts it can delegate to, or the pipeline recipes it can run. Asked in
 * chat, it answered from whatever happened to be in its advertised schema:
 * partial when it was lucky, invented when it was not.
 *
 * One tool, one call, no schemas — names and counts only, so the answer stays
 * small enough to be worth asking for. Sections exist because "which MCP
 * servers are up?" should not cost a full inventory.
 */

import type { ToolHandler } from '@/core/agent-base';
import { toolLogger } from '@/utils/logger';

const SELF_REPORT_TOOL_ID = 'self_report';

/** Sections a caller can ask for. `all` is the default. */
const SECTIONS = ['all', 'tools', 'mcp', 'skills', 'experts', 'pipelines'] as const;
type Section = (typeof SECTIONS)[number];

export interface SelfReportContext {
  /** Handlers advertised to the model this turn. */
  advertised: ToolHandler[];
  /** Handlers registered in the executor — callable by name whether advertised or not. */
  registered: ToolHandler[];
  /** Owner of the turn; scopes skills, experts and recipes. */
  userId?: string;
  /** The model actually serving this turn, and the role it is serving as. */
  model?: string;
  role?: string;
}

/** Group handler names by the toolbox that registered them. */
function byToolbox(handlers: ToolHandler[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const h of handlers) {
    const box = h.toolId ?? 'ungrouped';
    (out[box] ??= []).push(h.name);
  }
  for (const names of Object.values(out)) names.sort();
  return out;
}

/**
 * Each section is loaded independently and a failure in one is reported in
 * place rather than thrown: a broken MCP bridge should not stop the agent
 * being able to say which skills it has.
 */
async function safely<T>(label: string, load: () => Promise<T>): Promise<T | { unavailable: string }> {
  try {
    return await load();
  } catch (err) {
    // The full error goes to the log; the model gets the section name and a
    // short reason. Driver errors carry connection strings and host details,
    // and a tool result is the one place they would be echoed back into a
    // transcript.
    toolLogger.warn({ err, section: label }, 'capabilities: section unavailable');
    const reason = err instanceof Error ? err.message : String(err);
    return { unavailable: reason.slice(0, 120) };
  }
}

async function mcpSection() {
  const { getMCPBridge } = await import('@/mcp/bridge');
  const bridge = getMCPBridge();
  const connections = bridge.getAllConnections();
  const tools = bridge.getAllTools();
  return bridge.getServerConfigs().map((cfg) => ({
    name: cfg.name,
    connected: connections.find((c) => c.id === cfg.id)?.status === 'connected',
    tools: tools.filter((t) => t.serverId === cfg.id).length,
  }));
}

async function skillsSection(userId?: string) {
  // Fails CLOSED, like the experts and pipeline sections beside it. The
  // underlying store returns every user's rows when handed no id, so an absent
  // userId here would list another tenant's skill names.
  if (!userId) return [];
  // The REGISTRY, not the skill table. Skills mounted from the filesystem —
  // `~/.claude/skills`, `~/.agents/skills`, `~/.pi/agent/skills` and any
  // configured directory — live in memory with `external:` ids and never
  // reach the DB. Reading the table reported 22 skills on a machine where the
  // agent could actually load 40, which is a worse answer than none from a
  // tool whose whole job is to say what you can do. This is also the exact
  // source `list_skills` reads, so the inventory and the loader agree.
  const { getSkillRegistry } = await import('@/skills/registry');
  return (await getSkillRegistry().getAll(userId)).map((s) => s.name);
}

async function expertsSection(userId?: string) {
  const { eq, isNull, or } = await import('drizzle-orm');
  const { getDb } = await import('@/db/postgres');
  const { experts } = await import('@/db/schema/experts');
  const rows = await getDb()
    .select()
    .from(experts)
    .where(userId ? or(eq(experts.userId, userId), isNull(experts.userId)) : isNull(experts.userId));
  return rows.map((e) => ({ name: e.name, lane: e.topic }));
}

async function pipelinesSection(userId?: string) {
  const { listAvailableTemplates } = await import('@/core/agent/templates');
  return (await listAvailableTemplates(userId)).map((t) => ({ name: t.name, stages: t.stageCount }));
}

export function buildCapabilitiesHandler(ctx: SelfReportContext): ToolHandler {
  return {
    name: 'capabilities',
    description:
      'Report what you can actually do right now: your tools grouped by toolbox, the MCP ' +
      'servers mounted and whether they are connected, the skills you can load, the experts ' +
      'you can delegate to, and the pipeline recipes you can run. Call this before answering ' +
      'any question about your own abilities — do not answer from memory, and never guess a ' +
      'tool exists. Pass `section` to fetch one part instead of the whole inventory.',
    parameters: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          enum: [...SECTIONS],
          description: 'Which part to report. Defaults to "all".',
        },
      },
    },
    toolId: SELF_REPORT_TOOL_ID,
    previewParam: 'section',
    execute: async (args) => {
      const raw = typeof args?.section === 'string' ? args.section : 'all';
      const section = (SECTIONS as readonly string[]).includes(raw) ? (raw as Section) : 'all';
      const want = (s: Section) => section === 'all' || section === s;

      const report: Record<string, unknown> = { model: ctx.model, role: ctx.role };

      if (want('tools')) {
        // Advertised is what the model can see; registered is what it can call.
        // They differ on the lazy path, and the difference is the whole point of
        // list_tools — so say both rather than implying one number.
        report.tools = {
          advertised: ctx.advertised.length,
          callable: ctx.registered.length,
          byToolbox: byToolbox(ctx.registered),
        };
      }
      if (want('mcp')) report.mcpServers = await safely('mcp', mcpSection);
      if (want('skills')) report.skills = await safely('skills', () => skillsSection(ctx.userId));
      if (want('experts')) report.experts = await safely('experts', () => expertsSection(ctx.userId));
      if (want('pipelines')) report.pipelines = await safely('pipelines', () => pipelinesSection(ctx.userId));

      return report;
    },
  };
}
