# Plugin System

> **Deprecated.** The in-process plugins on this page are deprecated in favour
> of [plugin packages](PLUGIN-PACKAGES.md). They still load and behave as
> before, but the loader logs a one-time warning per plugin naming the
> converter. Convert one with `octi plugin convert <dir>`; see
> [Converting to a plugin package](#converting-to-a-plugin-package).

> For connections to other systems (DATEV, banks, Meta…) use a
> [plugin package](PLUGIN-PACKAGES.md): it runs as its own process with a
> minimal environment and declared tool effects. The plugins on this page run
> inside the server with its full rights.

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
3. Restart the backend, or call `POST /api/plugins/:name/reload` to hot-reload.
   The reload imports a fresh copy of the entry file (modules it imports
   itself are not re-evaluated) and initializes it before the running copy is
   shut down, so a copy that fails to load leaves the old one serving and the
   endpoint answers 500. Each reload keeps its predecessor in memory: it is a
   development aid.
4. Test via the tools API or by chatting with an agent

## Root agent hooks

In addition to registering tools, an in-process plugin can subscribe to the root agent's `before-agent-start` hook to mutate the system prompt before the LLM call (for example, to inject project-specific guidance or persona text). This is an internal host hook, not a field on `PluginContext`; a plugin must import the host hook registry from the checkout and should treat that coupling as version-sensitive. The hook is the same primitive the built-in persona system uses to layer the persona block between `SECURITY_PREAMBLE` and the role prompt.

```ts
import { getAgentHooks } from '@/core/agent/hooks';

getAgentHooks().register('before-agent-start', (ctx) => {
  if (!ctx.root) return;
  ctx.systemPrompt += '\n\n# project notes\n- All paths are relative to repo root.';
});
```

Handlers run sequentially in registration order. A thrown handler is logged and swallowed so a broken plugin can't poison the root agent. **Do not** strip or rewrite `SECURITY_PREAMBLE` — DESIGN.md house rule #6.

### From an extension: `octi.hook` (trusted extensions only)

An extension (`~/.octipus/extensions` or a project's `.octipus/extensions`) reaches the same hooks without importing host internals:

```ts
export default function (octi) {
  octi.hook('tool:before', (ctx) => {
    if (ctx.toolId === 'shell') ctx.args.command = String(ctx.args.command).replace(/sk-[A-Za-z0-9]+/g, '[redacted]');
  });
}
```

Events: `before-agent-start`, `tool:before` (rewrite `args` or short-circuit the call), `tool:after`, `spawn:before`, `spawn:after`, `context` (transform the messages of one model request) and `compact:before` (supply a compaction summary). Payload types are `AgentHookEvents` in `src/core/agent/hooks.ts`. The hook is removed when the extension is disposed (`/reload`).

#### `context`: transform one request's messages

Fired in the agent loop right before each model request, for the root agent and for swarm children. Payload: `{ agent: { userId, sessionId, role, workspaceId, metadata, root }, model, messages, iteration }`.

`messages` is a deep copy of the stored conversation. Replace or redact content, insert or append messages, or assign a new array: the worker sends the result for this request only. The stored conversation is never changed, so the next request, a compaction and the transcript start again from the original, and a hook cannot silently rewrite history. To keep a change, make it every time.

```ts
octi.hook('context', (ctx) => {
  const last = ctx.messages.at(-1);
  if (last?.role === 'tool') last.content = last.content.replace(/sk-[A-Za-z0-9]+/g, '[redacted]');
});
```

**Prompt cache and signed reasoning.** Providers cache the request prefix. Anything a `context` hook changes in an earlier message breaks the prompt cache from that message on, on every request it changes, so the whole conversation after it is read uncached. Changing an earlier assistant turn also invalidates its signed reasoning on Claude (the API rejects or ignores reasoning whose turn no longer matches). Append messages, or touch only the newest one. A redaction that has to apply to old messages is cheaper as a `tool:before`/`tool:after` policy, before the text enters the conversation at all.

With no `context` handler subscribed the request is the stored conversation itself: no copy is made.

#### `compact:before`: supply a compaction summary

Fired before a compaction summary is produced, on every path: the agent loop's own compaction (`source: 'agent'`: proactive, regular and context-overflow), a chat session checkpoint (`'session'`: `/compact` and the automatic pass between turns) and a room checkpoint (`'room'`, once per transcript chunk). Payload: `{ agent: { userId, sessionId, … }, source, messagesToSummarize, previousSummary?, userInstructions?, summary? }`.

`messagesToSummarize` is a frozen copy of what the summary replaces. Set `summary` to supply the summary yourself; the model summariser is then not called, and the log says a hook supplied it. The text goes through the same packaging as a model summary (the `[Context Summary …]` header and the cumulative file-operations list) and is capped at the summariser's output budget (`HOOK_SUMMARY_MAX_CHARS`, about 6,000 tokens). An empty or whitespace `summary` counts as none.

```ts
octi.hook('compact:before', async (ctx) => {
  ctx.summary = await mySummariser(ctx.messagesToSummarize, ctx.previousSummary, ctx.userInstructions);
});
```

A compaction rewrites the start of the conversation, so the prompt cache starts over after it whoever wrote the summary.

Hooks can rewrite what the agent does, so `octi.hook` throws unless the operator trusts the extension: list each trusted extension's entry file or directory, by absolute path, in `extensions.trusted` (or `OCTIPUS_TRUSTED_EXTENSIONS`, comma-separated). The list is read once, before the first extension's code runs, so changing it needs a restart; relative entries are ignored; paths are compared by real path, decided before the extension is imported, so an extension with the same name somewhere else is not trusted. Observing events (`octi.on`) and adding commands need no trust.

What this gate is and is not: it keeps an extension that was not meant to steer the agent from doing so. It is not a sandbox. Every extension, trusted or not, is in-process code with the server's privileges from the moment it loads, and `<cwd>/.octipus/extensions` loads automatically, so install only extensions you would run yourself.

Behaviour to know when writing a hook:

- `before-agent-start`, `context`, `compact:before`, `tool:after` and `spawn:after` handlers that throw are logged and skipped (a `compact:before` that throws leaves the built-in summariser to run). Changes a handler made to the payload before it threw stay. `tool:before` and `spawn:before` are fail-closed: a handler that throws blocks the call or spawn.
- A `tool:before` short-circuit (`ctx.shortCircuit = { result }`) answers the call without running the tool, and without its permission check. Rewritten `args` are permission-checked as usual.
- Extension hooks are registered after the built-in persona hook, so a `before-agent-start` hook sees, and could change, the persona block. Leave `SECURITY_PREAMBLE` alone.

## Converting to a plugin package

```bash
octi plugin convert extensions/my-plugin --out ./my-plugin-package \
  --effect lookup=read --network api.example.com
```

The converter wraps the plugin's handlers rather than rewriting them. It
writes, into an output directory that must be missing or empty (default
`./<name>-package`):

| File | What it is |
|---|---|
| `octipus-plugin.json` | The package manifest: name, version, description and author from `plugin.json`; one entry per tool; `server: node server.mjs`. Checked against the package contract before anything is written. |
| `server.mjs` | A generated, dependency-free MCP server over stdio. It imports `legacy/<main>`, calls `initialize` with a logger and an empty config as the legacy loader did, lists each tool with its parameters as JSON Schema, and dispatches `tools/call` to `module.tools[name]`. A thrown handler becomes an `isError` result. Logs, the plugin's and its `console`, go out as MCP log messages, since the host reads stderr as a transport error. |
| `package.json` | `"type": "module"`. |
| `legacy/` | A copy of the plugin directory (without `.git` and `node_modules/.bin`). |

The defaults are the most conservative ones the package format allows:

- **Effects:** every tool is `external` (always ASK, never unattended). Lower
  a tool with `--effect <tool>=read|write` once you have read its handler.
- **Network:** `[]`, unless `plugin.json` has a `network` host list or you pass
  `--network <host>` (repeatable). A plugin whose code uses the network
  (`fetch`, `http`/`https`/`net`, `WebSocket`, a client package) with no hosts
  declared is refused.
- **Protection ceiling:** `maxProtection` 1 when the package declares a host,
  4 when it declares none, the host's own defaults for those cases, written
  out explicitly.

Parameters go from the flat legacy map to JSON Schema: each entry becomes a
property with its `type`, `description` and `default`, and `required: true`
entries go into `required`.

The converter **refuses**, listing every reason at once and writing nothing,
when the plugin:

- imports host internals at runtime (`@/…`, or `@octipus/…` other than
  `import type`), registers a root agent hook (`getAgentHooks`), or reads the
  vault (`getVault`): a package runs outside the server and cannot reach them;
- declares `secrets`: legacy secrets are vault names resolved per calling
  user, while a package declares its own secrets, set by an admin and handed
  over as environment variables, so convert those by hand;
- imports files outside its directory, imports a relative path without a file
  extension (plain Node needs one), or contains a symbolic link (also under
  `node_modules`, apart from its `.bin` shims, which are not copied);
- has more than 500 code files outside `node_modules` (the scan would be
  partial);
- has a tool name MCP cannot carry, a parameter type with no JSON Schema
  equivalent, a declared tool with no handler (with `--check-handlers`), or a
  name the package format
  refuses (lower-case, `a-z0-9-`; `octipus`, `mcp`, `system`, `plugin` are
  reserved);
- has an entry that plain Node cannot load (`.tsx`, `.jsx`).

It warns, without refusing, about `capabilities.commands` and `events` (the
legacy host never read them), `process.env` reads (a package sees only a
minimal environment plus its settings and secrets), child processes, and
stdout writes.

Converting runs none of the plugin's code: it reads the sources. Pass
`--check-handlers` to also import the entry module once and check that every
declared tool has a handler; that runs its top-level code (not `initialize`)
in the CLI process, with your environment and no sandbox, so do it only for a
plugin you have read. Without it, a tool with no handler fails when called.
Dependencies under `node_modules` are copied but not scanned.

A TypeScript entry runs through Node's built-in type stripping (Node 22.18 or
newer), so it must use erasable syntax only: no `enum`, `namespace` or
parameter properties. Compile it to JavaScript first otherwise.

Then install the package as any other: `POST /api/plugin-packages { "path":
"<out>" }` ([PLUGIN-PACKAGES.md](PLUGIN-PACKAGES.md#installing-and-managing)),
and remove the plugin from `extensions/` so its tools are not offered twice.

## Example Plugin

See `extensions/example-plugin/` for a working example with a greeting tool and a calculator.

## Key Files

| File | Purpose |
|------|---------|
| `src/plugins/types.ts` | Plugin type definitions |
| `src/plugins/loader.ts` | Plugin discovery and loading |
| `src/plugins/plugin-tool.ts` | BaseTool wrapper for plugins |
| `src/plugins/convert.ts` | `octi plugin convert`: legacy plugin to plugin package |
| `src/plugins/index.ts` | Barrel exports |
| `src/api/routes/plugins.ts` | REST API routes |
| `extensions/` | Plugin directory (create plugins here) |

## Versioned contract (`@octipus/plugin-sdk`)

The `plugin.json` shape, the host API-version compatibility rule, and the
validation kit are owned by the repository's `@octipus/plugin-sdk` package, so
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
