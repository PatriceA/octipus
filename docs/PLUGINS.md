# Plugin System

Extend Octipus's capabilities by dropping plugins into the `extensions/` directory. Each plugin provides tools that are automatically registered and available to agents — no core code changes needed.

## Plugin Structure

A plugin is a directory inside `extensions/` containing:

```
extensions/
  my-plugin/
    plugin.json    # Manifest (required)
    index.ts       # Entry file (required)
```

### Manifest (`plugin.json`)

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "Does something useful",
  "author": "Your Name",
  "main": "index.ts",
  "tools": [
    {
      "name": "my_tool",
      "description": "Does a specific thing",
      "parameters": {
        "input": { "type": "string", "description": "The input value", "required": true },
        "limit": { "type": "number", "description": "Max results", "default": 10 }
      }
    }
  ]
}
```

### Entry File (`index.ts`)

```typescript
export default {
  name: 'my-plugin',

  // Called when the plugin is loaded (optional)
  async initialize(context) {
    context.logger.info('Plugin initialized');
  },

  // Tool implementations — keyed by tool name from manifest
  tools: {
    async my_tool(args) {
      const input = args.input as string;
      return { result: `Processed: ${input}` };
    },
  },

  // Called on shutdown (optional)
  async shutdown() {},
};
```

## How It Works

1. At startup, `loadPlugins()` scans `extensions/` for directories with `plugin.json`
2. Each manifest is validated (name, version, description, main, tools)
3. The entry file is dynamically imported via `await import()`
4. `initialize()` is called with a `PluginContext` (logger)
5. Each plugin is wrapped in a `PluginTool` (extends `BaseTool`) and registered with the tool registry
6. Plugin tools become available to agents as `plugin-<name>__<tool_name>`

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `GET /api/plugins` | GET | List all loaded plugins with manifests |
| `GET /api/plugins/:name` | GET | Details for a specific plugin |
| `POST /api/plugins/:name/reload` | POST | Hot-reload a plugin from disk |

## Development Workflow

1. Create your plugin directory in `extensions/`
2. Write `plugin.json` and `index.ts`
3. Restart the backend, or call `POST /api/plugins/:name/reload` to hot-reload
4. Test via the tools API or by chatting with an agent

## Root agent hooks

In addition to registering tools, plugins can subscribe to the root agent's `before-agent-start` hook to mutate the system prompt before the LLM call (e.g., inject project-specific guidance, custom security rules, or a different persona). The hook is the same primitive the built-in persona system uses to layer the persona block between `SECURITY_PREAMBLE` and the role prompt.

```ts
import { getAgentHooks } from '@/core/agent/hooks';

getAgentHooks().register('before-agent-start', (ctx) => {
  if (ctx.role !== 'root agent') return;
  ctx.systemPrompt += '\n\n# project notes\n- All paths are relative to repo root.';
});
```

Handlers run sequentially in registration order. A thrown handler is logged and swallowed so a broken plugin can't poison the root agent. **Do not** strip or rewrite `SECURITY_PREAMBLE` — DESIGN.md house rule #6.

## Example Plugin

See `extensions/example-plugin/` for a working example with a greeting tool and a calculator.

## Key Files

| File | Purpose |
|------|---------|
| `src/plugins/types.ts` | Plugin type definitions |
| `src/plugins/loader.ts` | Plugin discovery and loading |
| `src/plugins/plugin-tool.ts` | BaseTool wrapper for plugins |
| `src/plugins/index.ts` | Barrel exports |
| `src/api/routes/plugins.ts` | REST API routes |
| `extensions/` | Plugin directory (create plugins here) |

## Versioned contract (`@octipus/plugin-sdk`)

The `plugin.json` shape, the host API-version compatibility rule, and the
validation kit are owned by the published `@octipus/plugin-sdk` package, so
plugin authors and the host validate against the **same** definition.

### `apiVersion`

Declare the contract version your plugin targets:

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "…",
  "apiVersion": "1.0.0",
  "main": "index.ts",
  "capabilities": {
    "tools": [
      { "name": "my_tool", "description": "…", "parameters": { "input": { "type": "string", "description": "…", "required": true } } }
    ]
  }
}
```

- The host **refuses** a plugin whose MAJOR differs from the host's
  `PLUGIN_API_VERSION`, or whose MINOR is newer than the host.
- A manifest **without** `apiVersion` still loads, with a **deprecation
  warning** (legacy). Add `apiVersion` to silence it.
- `capabilities.tools` is the canonical tool list; the legacy top-level `tools`
  array is still accepted when `capabilities` is absent.

### Validate before you ship

```bash
octi plugin validate ./extensions/my-plugin
```

This runs the full pre-flight the host runs at load time — manifest schema,
apiVersion compatibility, module shape, an `initialize` dry-run, and a fixture
dry-run of every declared tool. It exits non-zero on any fatal error. A CI
workflow (`.github/workflows/plugin-validate.yml`) runs it over every plugin in
`extensions/`.

Authors can run the same check in their own CI:

```ts
import { validatePlugin } from '@octipus/plugin-sdk/testing';
const report = await validatePlugin('./my-plugin');
if (!report.ok) { console.error(report.errors.join('\n')); process.exit(1); }
```

> **Remote install** (`octi plugin install npm:… / github:…`) is a planned
> follow-up; it stays deferred until plugin signing exists, since installing a
> plugin executes third-party code in-process.
