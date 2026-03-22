# Plugin System

Extend the assistant's capabilities by dropping plugins into the `extensions/` directory. Each plugin provides tools that are automatically registered and available to agents — no core code changes needed.

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
