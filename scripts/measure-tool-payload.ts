/**
 * Phase 6 measurement for lazy tool discovery (docs/plans/lazy-tool-discovery.md).
 *
 * Computes the advertised `tools` payload for the research role — full schema vs
 * lazy (core + discovery meta-tools) — without needing a live backend. Tool
 * discovery + initialize() need no DB/config (see tools/conformance.test.ts).
 *
 * Run: npx tsx scripts/measure-tool-payload.ts
 */
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import type { ToolHandler } from '@/core/agent-base';
import { getRoleConfig } from '@/core/orchestrator/roles';
import { splitRoleTools } from '@/core/orchestrator/tool-split';
import { buildToolDiscoveryHandlers } from '@/tools/tool-discovery';
import { discoverTools } from '@/tools/discovery';

function advertise(handlers: ToolHandler[]): ChatCompletionTool[] {
  return handlers.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf-8');
const approxTokens = (v: unknown) => Math.round(bytes(v) / 4); // ~4 chars/token

const role = getRoleConfig('research');
console.log(`Role: research`);
console.log(`  toolIds:     ${role.toolIds.join(', ')}`);
console.log(`  coreToolIds: ${(role.coreToolIds ?? ['<none>']).join(', ')}\n`);

// Discover + initialize built-in tools (no DB/config needed).
const discovered = await discoverTools();
for (const { tool } of discovered) {
  try {
    await tool.initialize();
  } catch (err) {
    console.warn(`  ! ${tool.id} initialize failed: ${(err as Error).message}`);
  }
}
const byId = new Map(discovered.map((d) => [d.tool.id, d.tool]));

// Collect the role's handlers (skip 'mcp' — no connections in this harness, and
// it stays core regardless).
const handlers: ToolHandler[] = [];
for (const id of role.toolIds) {
  if (id === 'mcp') continue;
  const tool = byId.get(id);
  if (!tool) {
    console.warn(`  ! toolId '${id}' not discovered — skipped`);
    continue;
  }
  handlers.push(...tool.getToolHandlers());
}

const { core, longTail } = splitRoleTools(handlers, role.coreToolIds);
const discovery = buildToolDiscoveryHandlers(longTail);

const full = advertise(handlers);
const lazy = advertise([...core, ...discovery]);

const perTool = handlers
  .map((h) => ({ name: h.name, toolId: h.toolId, bytes: bytes(advertise([h])[0]) }))
  .sort((a, b) => b.bytes - a.bytes);

console.log(`Per-handler advertised size (bytes), heaviest first:`);
for (const t of perTool) {
  console.log(`  ${String(t.bytes).padStart(6)}  ${t.toolId ?? '-'} :: ${t.name}`);
}

console.log(`\nAdvertised tool array:`);
console.log(`  FULL : ${full.length} tools, ${bytes(full)} bytes (~${approxTokens(full)} tokens)`);
console.log(`  LAZY : ${lazy.length} tools (${core.length} core + ${discovery.length} discovery), ${bytes(lazy)} bytes (~${approxTokens(lazy)} tokens)`);
console.log(`  long tail behind discovery: ${longTail.length} handlers`);
const reduction = full.length > 0 ? (1 - bytes(lazy) / bytes(full)) * 100 : 0;
console.log(`  REDUCTION: ${reduction.toFixed(1)}% of advertised tool bytes`);

// Optional: dump the two arrays for a live prefill comparison against ollama.
if (process.env.DUMP_TOOLS) {
  const { writeFileSync } = await import('fs');
  // Ollama native tool format == { type:'function', function:{ name, description, parameters } }
  writeFileSync('/tmp/full-tools.json', JSON.stringify(full));
  writeFileSync('/tmp/lazy-tools.json', JSON.stringify(lazy));
  console.log(`\n  wrote /tmp/full-tools.json and /tmp/lazy-tools.json`);
}
