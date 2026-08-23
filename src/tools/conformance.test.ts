/**
 * Tool conformance (T2) — structural coverage across the ENTIRE built-in tool
 * surface, most of which had no tests. Rather than brittle, mock-heavy tests
 * for each I/O-bound tool, this exercises every auto-discovered tool's manifest
 * and registered handlers and asserts the invariants the orchestrator,
 * permission system, and provider envelopes rely on:
 *
 *   - unique tool container IDs (registry.register throws on dupes)
 *   - well-formed manifest (id/name/version/description, permission shape)
 *   - permission defaultLevels are valid; dangerous actions are flagged
 *   - every registered handler has a name, a JSON-schema-shaped `parameters`,
 *     and carries handler.toolId === tool.id (load-bearing for the swarm
 *     permission intersection — see BaseTool.registerTool)
 *   - array params declare `items` (Gemini envelope requirement)
 *
 * A regression in any tool's registration now fails here instead of at runtime.
 */
import { describe, expect, test } from 'vitest';
import type { BaseTool } from './base-tool';
import { discoverTools } from './discovery';

const VALID_LEVELS = new Set(['ALLOW', 'ASK', 'DENY']);

// Discover + initialize every built-in tool once. discoverTools() only imports
// folders and collects BaseTool exports — no config/DB/network needed.
const discovered = await discoverTools();
const tools: { folder: string; tool: BaseTool }[] = discovered;

// Initialize each tool so its handlers are registered (registerTools runs).
for (const { tool } of tools) {
  await tool.initialize();
}

describe('tool discovery', () => {
  test('discovers a non-trivial set of built-in tools', () => {
    expect(tools.length).toBeGreaterThanOrEqual(15);
  });

  test('every discovered folder yields a tool with a stable id', () => {
    for (const { folder, tool } of tools) {
      expect(typeof tool.id, `${folder} tool.id`).toBe('string');
      expect(tool.id.length, `${folder} tool.id non-empty`).toBeGreaterThan(0);
    }
  });

  test('tool container ids are unique', () => {
    const ids = tools.map((t) => t.tool.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('tool manifests', () => {
  for (const { folder, tool } of tools) {
    test(`${folder}: manifest is well-formed`, () => {
      const m = tool.getManifest();
      expect(m.id, 'id').toBe(tool.id);
      expect(typeof m.name, 'name').toBe('string');
      expect(m.name.length).toBeGreaterThan(0);
      expect(typeof m.version, 'version').toBe('string');
      expect(typeof m.description, 'description').toBe('string');
      expect(Array.isArray(m.permissions), 'permissions is array').toBe(true);
    });

    test(`${folder}: permissions are valid`, () => {
      const m = tool.getManifest();
      const seen = new Set<string>();
      for (const p of m.permissions) {
        expect(typeof p.action, `${folder} permission.action`).toBe('string');
        expect(p.action.length).toBeGreaterThan(0);
        expect(VALID_LEVELS.has(p.defaultLevel), `${folder} ${p.action} defaultLevel=${p.defaultLevel}`).toBe(true);
        // A dangerous action should default to ASK or DENY, never ALLOW.
        if (p.dangerous) {
          expect(p.defaultLevel, `${folder} dangerous action ${p.action}`).not.toBe('ALLOW');
        }
        // No duplicate permission actions within a tool.
        expect(seen.has(p.action), `${folder} duplicate permission ${p.action}`).toBe(false);
        seen.add(p.action);
      }
    });
  }
});

describe('tool handlers', () => {
  for (const { folder, tool } of tools) {
    test(`${folder}: every handler is well-formed`, () => {
      const handlers = tool.getToolHandlers();
      // A tool may legitimately register zero handlers only if it also declares
      // none in the manifest; most register at least one.
      for (const h of handlers) {
        expect(typeof h.name, `${folder} handler.name`).toBe('string');
        expect(h.name.length).toBeGreaterThan(0);
        // Load-bearing: the swarm permission intersection looks up handler.toolId
        // against the parent's allowed container ids (see BaseTool.registerTool).
        expect(h.toolId, `${folder} handler ${h.name} toolId`).toBe(tool.id);
        expect(typeof h.execute, `${folder} handler ${h.name} execute`).toBe('function');

        const params = h.parameters as Record<string, unknown> | undefined;
        expect(params, `${folder} handler ${h.name} parameters`).toBeDefined();
        // createParameterSchema emits { type:'object', properties, required }.
        expect((params as { type?: string }).type, `${folder} ${h.name} schema type`).toBe('object');
        const props = (params as { properties?: Record<string, Record<string, unknown>> }).properties ?? {};
        for (const [pname, pschema] of Object.entries(props)) {
          // Gemini envelope requires array params to declare an element schema.
          if (pschema.type === 'array') {
            expect(pschema.items, `${folder} ${h.name} param ${pname} (array) needs items`).toBeDefined();
          }
        }
      }
    });

    test(`${folder}: handler names are unique within the tool`, () => {
      const names = tool.getToolHandlers().map((h) => h.name);
      expect(new Set(names).size).toBe(names.length);
    });
  }
});
