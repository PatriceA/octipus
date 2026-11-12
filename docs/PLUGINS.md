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

Extend Octipus's capabilities by dropping plugins into `~/.octipus/legacy-plugins/`. Each plugin provides tools that are automatically registered and available to agents — no core code changes needed.

> **Not from the Octipus checkout.** None of the plugin systems read plugins
> from the Octipus checkout or the server's working directory: legacy plugins
> load from `~/.octipus/legacy-plugins/`, in-process extensions from
> `~/.octipus/extensions/`, and plugin packages from the plugin store under
> `workspace.rootPath` ([PLUGIN-PACKAGES.md](PLUGIN-PACKAGES.md#where-plugins-live)).
> Legacy plugins used to load from `<cwd>/extensions/`; that directory is no
> longer read. If it still holds plugins, the server logs one warning naming
> them: move each to `~/.octipus/legacy-plugins/`, or convert it with
> `octi plugin convert` ([below](#converting-to-a-plugin-package)). A
> project's `<cwd>/.octipus/extensions/` is no longer loaded either.

## Plugin Structure

A plugin is a directory inside `~/.octipus/legacy-plugins/` containing:

```
~/.octipus/legacy-plugins/
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

1. At startup, `loadPlugins()` scans `~/.octipus/legacy-plugins/` for directories with `plugin.json`
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

1. Create your plugin directory in `~/.octipus/legacy-plugins/` (outside the Octipus checkout)
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

An extension (`~/.octipus/extensions`; a project's `.octipus/extensions` is not loaded) reaches the same hooks without importing host internals:

```ts
export default function (octi) {
  octi.hook('tool:before', (ctx) => {
    if (ctx.toolId === 'shell') ctx.args.command = String(ctx.args.command).replace(/sk-[A-Za-z0-9]+/g, '[redacted]');
  });
}
```

Events: `before-agent-start`, `tool:before` (rewrite `args` or short-circuit the call), `tool:after` (redact or replace the result), `spawn:before`, `spawn:after`, `context` (transform the messages of one model request) and `compact:before` (supply a compaction summary). Payload types are `AgentHookEvents` in `src/core/agent/hooks.ts`. The hook is removed when the extension is disposed (`/reload`).

**Versioning.** `octi.hookApiVersion` (`OCTI_HOOK_API_VERSION` from `@/extensions`, `AGENT_HOOK_API_VERSION` in `hooks.ts`) is the version of this contract, currently `1`. Within a version, event names, payload shapes and each event's failure mode are stable: a payload may gain a field, but no field is removed, renamed or given another meaning, and no event switches between fail-open and fail-closed. Anything else bumps the number. An extension that relies on a field can check it at load: `if (octi.hookApiVersion !== 1) throw new Error('needs hook API v1')`.

A failure in an extension's hook is reported with the extension's name: `<event> hook failed: extension "<name>": <message>`.

#### `tool:after`: redact or replace a tool result

Fired after every tool call dispatched through `BaseTool` (built-in tools, plugin tools and extension tools; MCP calls and the agent's own orchestration tools such as `spawn_child` do not fire `tool:before`/`tool:after`), on every outcome, including a `tool:before` short-circuit. Payload: `{ toolId, toolName, args, agent, status, result, error, durationMs }`, `status` one of `success`, `error`, `cancelled`, `denied`.

On `success` a handler may assign `ctx.result`. Handlers run in registration order, each sees the previous one's value, and the value left after the last one is what the call returns. That one value is what the model receives as the tool result, what the UI's `tool_call_complete` event previews, what the audit row (`tool_executed`) stores and what the `tool_post` hooks receive: nothing downstream sees the original. Not covered: output a tool streams to the UI while it runs (live shell output, progress events), which has left before the tool returns, and the arguments, which `tool:before` redacts.

```ts
octi.hook('tool:after', (ctx) => {
  if (ctx.status !== 'success') return;
  ctx.result = JSON.parse(JSON.stringify(ctx.result).replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]'));
});
```

**Failure.** On `success`, `tool:after` is fail-closed: a handler that throws stops the chain, later handlers do not run, and the result is withheld. The call returns `{ error: "tool:after hook failed: extension \"<name>\": <message>. <tool> ran, but its result was withheld …" }` instead, so a redaction that crashed halfway never leaks what it was hiding. It is returned rather than thrown because the tool did run: a thrown error reads as "did not happen" to the run's side-effect counters and invites the model to retry a write. On `error`, `cancelled` and `denied` there is no result to withhold: a throwing handler is logged and skipped, the original error is what the model sees, and assigning `ctx.result` does nothing. The built-in `tool:after` subscriber (the run log) does not throw, so this changes nothing for it; a metrics or tracing hook written for `tool:after` should catch its own errors, since on success its failure now withholds the result.

#### `octi.registerTool`: add a tool (trusted extensions only)

```ts
octi.registerTool({
  id: 'quote',
  description: 'Look up a stock quote',
  parameters: { type: 'object', properties: { symbol: { type: 'string', description: 'Ticker' } }, required: ['symbol'] },
  effect: 'read',
  handler: async (args, ctx) => ({ symbol: args.symbol, price: await price(String(args.symbol)) }),
});
```

The tool is registered in the tool registry as `ext_<extension>__<id>` (an extension named `stocks` gives `ext_stocks__quote`), inside one tool group per extension, `ext_<extension>`. The extension name is used as it is, so it must already be lower-case letters, digits and single underscores, starting with a letter: an extension named `my-stocks` or `Stocks` cannot register tools until its file or directory is renamed (`my_stocks`). Names are not slugged because a slug is not one-to-one (`foo-bar` and `foo_bar` would share a group and its permission policies). `id` is lower-case letters, digits and single underscores, starting with a letter, and the whole name must fit the providers' 64-character limit. Collisions are refused with an error, never resolved by overwriting: a second tool with the same id, or a group already held by anything (a plugin or a built-in; built-ins never start with `ext_`). If registering the group fails, the group is released and every later `registerTool` call of that extension throws. `parameters` is a JSON Schema object; its `required` list is enforced before the handler runs. `ctx` is `{ userId, sessionId, role, workspaceId }`. The return value is the tool result; a throw is a failed call.

Every call goes through the same middleware as a built-in tool: `tool:before`/`tool:after`, the permission check, approval, the audit row and mutation recovery. `effect` decides the permission action:

| `effect` | Permission action (tool `quote`) | Default | Notes |
|----------|-------------------|---------|-------|
| `read` | `read:quote` | ALLOW | Read-only: no mutation journal. |
| `write` | `write:quote` | ASK | |
| `external` | `external:quote` | ASK, `dangerous` | A broad allow rule (`ext_stocks(*)`) does not lift it; only an explicit stored policy for that tool does, as for any dangerous built-in action. |

The action is per tool, `<effect>:<id>`, so a stored policy (an "always allow" answer to an approval, or one an admin sets on `toolId` `ext_stocks`, action `write:trade`) covers exactly one tool, never the extension's other tools or tools it adds later.

**Flow guard.** Every extension tool result marks the session `suspicious` (untrusted code produced it), whatever the effect, so it is never less strict than an MCP tool. `write` and `external` tools are write egress: after the session mixed private data with untrusted content, or read credential material, they need approval even when their level is ALLOW. A `read` tool is query egress, like a web search: it receives its arguments and is usually a lookup against a remote service, so it asks after the session read credential material.

To give agents the tools, list the group in a role's tools (`ext_stocks`), as for a plugin's `plugin-<name>`. On a role with a core tool set, lazy discovery puts the group in the long tail: `list_tools` lists the tools and `describe_tool` returns their schema. `octi.registerTool` returns a function that removes that one tool; disposing the extension (`/reload`, shutdown) removes the group. A worker that started before the dispose still holds the handler; calling it answers `{ error: "… is no longer registered" }` without running the extension's code. An untrusted extension's `registerTool` throws, like its `hook`.

#### `octi.registerProvider`: add a model endpoint (trusted extensions only)

```ts
const off = await octi.registerProvider({
  id: 'gateway',                         // lower-case letters, digits, hyphens
  kind: 'openai-compatible',             // or 'anthropic-compatible' | 'gemini-compatible'
  baseUrl: 'https://llm.example.com',    // https, public addresses only
  apiKeySecret: 'ext.acme.gateway_key',  // the NAME of a system vault secret, in ext.<extension>.
  headers: { 'X-Team': 'research' },     // optional, never credentials
  models: [{ id: 'acme-large', contextWindow: 200_000, maxOutput: 8192, costPerMillionInput: 1, costPerMillionOutput: 4 }],
});
```

This registers an endpoint, not provider code. Each kind is one of the custom providers an admin can already configure (`openai-compatible` is `custom-openai`, `anthropic-compatible` is `custom-anthropic`, `gemini-compatible` is `custom-gemini`; `src/models/providers/custom/`), and each model becomes an in-memory model row on that provider, named `ext/<extension>/<id>/<model id>` (`ext/acme/gateway/acme-large`). The router, the custom provider, protection routing and cost tracking serve it as they serve a configured custom provider. `ProviderId`, the generated model catalog, the pricing tables and the setup flow are unchanged.

What is supported:

- **Choosing the model by its exact name**: `/model ext/acme/gateway/acme-large`, an agent's or a pipeline stage's model, `model: "ext/acme/gateway/acme-large"` on the OpenAI-compatible API. The row's model id is that same name, and the id the extension registered (`acme-large`) is only what goes upstream. So a bare vendor id never reaches an extension row: `gpt-4o` still goes to the built-in provider, and a user's personal row (or an admin's row) with the same model id still serves that id. The rows appear in a user's model list (`/models`, the pickers) and in the admin listing, marked `extension: true`. They are install rows, visible to whoever may use the install's models.
- **Endpoint**: `baseUrl` must be `https://`, carry no credentials, query or fragment, and not name localhost or a private, loopback, link-local or ambiguous IP literal. Registration then resolves the host and refuses it when any address is private (`validateExternalUrl`), and every request goes through the SSRF-guarded fetch personal models use: re-resolved, pinned to the checked address, redirects not followed. These are the personal-endpoint rules, stricter than an admin-configured custom row (which may point at a local server). A local endpoint is configured by an admin as a custom provider instead.
- **Key**: `apiKeySecret` names a system vault secret in the extension's own namespace, `ext.<extension>.<name>` (`<name>`: letters, digits, `_` and `-`), read at request time. Any other secret is refused, so an extension cannot send the install's provider keys, mailbox tokens or plugin secrets to its endpoint (a lookup by name does not apply a secret's `allowedTools` / `allowedAgents`); so are reserved system secrets, a raw key (`apiKey`), an `env:` reference and credential headers (`Authorization`, `x-api-key`, `Cookie`, …). Unlike an admin-configured custom row there is no `CUSTOM_OPENAI_API_KEY`-style env fallback: a missing secret fails the call. The key goes in the kind's usual header (`Authorization: Bearer`, `x-api-key`, `x-goog-api-key`); `authHeader` names another, but never a transport, cookie or proxy header. An extension whose name is not letters, digits, `_` and `-` cannot register providers. An admin stores the key as a system-level secret:

  ```bash
  curl -X POST http://localhost:3005/api/vault \
    -H "Authorization: Bearer $OCTIPUS_API_TOKEN" -H 'Content-Type: application/json' \
    -d '{ "name": "ext.acme.gateway_key", "value": "<the key>", "credentialType": "api_key", "systemLevel": true }'
  ```

- **Its own rate-limit bucket and circuit breaker**, keyed by the logical provider id `ext:<extension>:<id>` (`ext:acme:gateway`). A failing extension endpoint opens its own breaker, never the `custom-openai` / `custom-anthropic` / `custom-gemini` one the admin's custom models share.
- **Options**: `path` replaces the kind's default request path; per model, `supportsTools` (default true), `supportsVision` (false), `supportsStreaming` (true), `costPerMillionInput` / `costPerMillionOutput` (USD, default 0), `description`.
- **Collisions** are refused, never resolved by overwriting: an id spelled like a built-in provider (`openai`, `custom-openai`, …), the same id twice in one extension, or a database row already holding the `ext/` name. Two extensions may register the same upstream id: their names differ. The `ext/` namespace is reserved: the model registry and the admin routes refuse to create a database row with an `ext/` name or model id, and refuse to update, enable or disable, delete or make default an extension row.
- **Lifecycle**: the definition is copied when the call is made (it must be plain data). Invalid definitions and an untrusted extension throw synchronously. The returned promise resolves to the unregister function once the DNS and database checks pass, and rejects otherwise with nothing registered; a refusal or failure is also logged, for an extension that does not await it. Disposing the extension (`/reload`, shutdown) removes its rows; a request already running finishes.

What is not supported:

- **Provider code.** No custom request/response handling, auth flows (OAuth, request signing), or protocols other than the three kinds.
- **Defaults, topic bindings and automatic selection.** The rows never become the install default, a topic's primary or backup, or a fallback, and they are left out of the list automatic model selection and the health checker read (`getAllModels`). The topic binding and default live in the database, which the rows are not in.
- **Reaching a row by its upstream id**, editing it in the admin registry, embeddings, OCR and the native decision API (`decisionProtocol`, which needs a local endpoint).
- **Personal or org-scoped rows**: the rows are install-wide.
- **Persistence**: the rows exist while the extension is loaded.

A trusted extension runs in the process and could reach the vault and the network on its own; these rules keep the key out of its source, keep its endpoint off the internal network, keep it from borrowing the install's other secrets through the provider path, and keep its models from capturing traffic meant for the ones an admin or a user configured.

#### `context`: transform one request's messages

Fired in the agent loop right before each model request, for the root agent and for swarm children. Payload: `{ agent: { userId, sessionId, role, workspaceId, metadata, root }, model, messages, iteration }`.

`messages` is a deep copy of the stored conversation. Replace or redact content, insert or append messages, or assign a new array: the worker sends the result for this request only. The stored conversation is never changed, so the next request, a compaction and the transcript start again from the original, and a hook cannot silently rewrite history. To keep a change, make it every time.

```ts
octi.hook('context', (ctx) => {
  const last = ctx.messages.at(-1);
  if (last?.role === 'tool') last.content = last.content.replace(/sk-[A-Za-z0-9]+/g, '[redacted]');
});
```

**Prompt cache and signed reasoning.** Providers cache the request prefix. Anything a `context` hook changes in an earlier message breaks the prompt cache from that message on, on every request it changes, so the whole conversation after it is read uncached. Claude's signed reasoning is bound to every message before it, so from the first message a hook changed, dropped or inserted before on, the worker leaves signed reasoning out of that request (the stored conversation keeps it); an edit to an early turn costs the model its earlier thinking as well as the cache. Append messages, or touch only the newest one. A redaction that has to apply to old messages is cheaper as a `tool:before`/`tool:after` policy, before the text enters the conversation at all.

**Failure.** `context` is fail-closed, like `tool:before` and `spawn:before`: a handler that throws stops the request before anything is sent, and the run fails with `context hook failed: <message>` (`HookFailedError`). Later handlers do not run, and edits made before the throw are discarded, so a redaction that crashed halfway never goes out. The same holds when the conversation cannot be deep-copied for the hook (an uncloneable provider payload) or a handler leaves `messages` not an array: the request fails rather than going out unhooked.

**Compaction.** The hook shapes model requests of the agent loop only. A compaction summary is written from the stored conversation, whether the model continues the conversation to write it or a standalone summariser does; shape or replace it with `compact:before`.

With no `context` handler subscribed the request is the stored conversation itself: no copy is made.

#### `compact:before`: supply a compaction summary

Fired before a compaction summary is produced, on every path: the agent loop's own compaction (`source: 'agent'`: proactive, regular and context-overflow), a chat session checkpoint (`'session'`: `/compact` and the automatic pass between turns) and a room checkpoint (`'room'`, once per transcript chunk). Payload: `{ agent: { userId, sessionId, … }, source, messagesToSummarize, previousSummary?, userInstructions?, summary? }`.

`messagesToSummarize` is a deep, deep-frozen copy of what the summary replaces: tool calls, their arguments and provider payloads included, nothing is shared with the history, and any write to it throws. Set `summary` to supply the summary yourself; the model summariser is then not called, and the log says a hook supplied it. The text goes through the same packaging as a model summary (the `[Context Summary …]` header and the cumulative file-operations list) and is capped at the output budget the model summariser would get for the same messages: a fifth of their tokens, between about 1,000 and 6,000 tokens, at about 4 characters a token (`hookSummaryMaxChars`; never more than `HOOK_SUMMARY_MAX_CHARS`). A longer summary is cut and marked `[... summary truncated]`. An empty or whitespace `summary` counts as none.

```ts
octi.hook('compact:before', async (ctx) => {
  ctx.summary = await mySummariser(ctx.messagesToSummarize, ctx.previousSummary, ctx.userInstructions);
});
```

A compaction rewrites the start of the conversation, so the prompt cache starts over after it whoever wrote the summary.

Hooks, tools and providers can rewrite what the agent does or see all of it, so `octi.hook`, `octi.registerTool` and `octi.registerProvider` throw unless the operator trusts the extension: list each trusted extension's entry file or directory, by absolute path, in `extensions.trusted` (or `OCTIPUS_TRUSTED_EXTENSIONS`, comma-separated). The list is read once, before the first extension's code runs, so changing it needs a restart; relative entries are ignored; paths are compared by real path, decided before the extension is imported, so an extension with the same name somewhere else is not trusted. Observing events (`octi.on`) and adding slash commands (`octi.registerCommand`) need no trust.

What this gate is and is not: it keeps an extension that was not meant to steer the agent from doing so. It is not a sandbox. Every extension, trusted or not, is in-process code with the server's privileges from the moment it loads, and everything in `~/.octipus/extensions` loads automatically, so install only extensions you would run yourself. (A project's `<cwd>/.octipus/extensions` is not loaded: a cloned repository cannot bring an extension in by being the working directory. The server logs one warning naming any it skips; move the ones you trust to `~/.octipus/extensions`.)

**Installing a trusted extension as an in-process plugin.** The way to run a trusted extension in production is to install it like a plugin package, with `"runtime": "in-process"` and `"entry"` naming the module, bundled into one ES module file (for example with `esbuild --bundle`) ([PLUGIN-PACKAGES.md](PLUGIN-PACKAGES.md#runtimes)). It is then copied into the plugin directory, pinned by content hash, signed and checked against `plugins.trustedPublishers` and `plugins.revokedKeys`, listed on Admin → Plugin packages and audited, and it runs only after an admin approves its content and, separately, approves running it in the server process for that hash. It is trusted (`hook`, `registerTool`, `registerProvider` work) without an `extensions.trusted` entry, loads and unloads when it is enabled, disabled, upgraded or uninstalled, without a restart, and its registrations are disposed in reverse order.

Extensions in `~/.octipus/extensions` keep working for development: they are not pinned (no hash, signature or approval: whatever is on disk at load runs), and the server logs that once. `extensions.trusted` (and `OCTIPUS_TRUSTED_EXTENSIONS`) keeps working for them, but is deprecated: install anything you trust as an in-process plugin instead.

Behaviour to know when writing a hook:

- `before-agent-start`, `compact:before`, `spawn:after`, and `tool:after` on a failed call, are fail-open: a handler that throws is logged and skipped (a `compact:before` that throws leaves the built-in summariser to run), and changes it made to the payload before it threw stay. `tool:before`, `spawn:before`, `context`, and `tool:after` on a successful call, are fail-closed: a handler that throws blocks the call, the spawn or the model request, or withholds the result.
- A `tool:before` short-circuit (`ctx.shortCircuit = { result }`) answers the call without running the tool, and without its permission check. Rewritten `args` are permission-checked as usual.
- Extension hooks are registered after the built-in persona hook, so a `before-agent-start` hook sees, and could change, the persona block. Leave `SECURITY_PREAMBLE` alone.

## Converting to a plugin package

```bash
octi plugin convert ~/.octipus/legacy-plugins/my-plugin --out ~/my-plugin-package \
  --effect lookup=read --network api.example.com
```

The converter wraps the plugin's handlers rather than rewriting them. It
writes, into an output directory that must be missing or empty (default
`./<name>-package`, so run it outside the Octipus checkout or pass `--out`):

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
and remove the plugin from `~/.octipus/legacy-plugins/` so its tools are not offered twice.

## Example Plugin

The example plugin is [`plugins/reader`](../plugins/reader), a plugin package
([PLUGIN-PACKAGES.md](PLUGIN-PACKAGES.md)). No legacy plugin ships with
Octipus; the converter and validator tests use the fixture in
`tests/fixtures/legacy-plugin/` (a greeting tool and a calculator).

## Key Files

| File | Purpose |
|------|---------|
| `src/plugins/types.ts` | Plugin type definitions |
| `src/plugins/loader.ts` | Plugin discovery and loading |
| `src/plugins/plugin-tool.ts` | BaseTool wrapper for plugins |
| `src/plugins/convert.ts` | `octi plugin convert`: legacy plugin to plugin package |
| `src/plugins/index.ts` | Barrel exports |
| `src/api/routes/plugins.ts` | REST API routes |
| `~/.octipus/legacy-plugins/` | Legacy plugin directory (per user, outside the checkout) |
| `src/extensions/api.ts` | The `octi` API of user extensions: `on`, `registerCommand`, `hook`, `registerTool`, `registerProvider`, `hookApiVersion` |
| `src/extensions/providers.ts` | `registerProvider` validation and registration; the rows live in `src/models/extension-models.ts` |
| `src/extensions/tools.ts` | Extension tool groups (`ext_<extension>`) in the tool registry |
| `src/core/agent/hooks.ts` | Hook events, payloads and `AGENT_HOOK_API_VERSION` |

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
octi plugin validate ~/.octipus/legacy-plugins/my-plugin
```

This runs the full pre-flight the host runs at load time — manifest schema,
apiVersion compatibility, module shape, an `initialize` dry-run, and a fixture
dry-run of every declared tool. It exits non-zero on any fatal error. A CI
workflow (`.github/workflows/plugin-validate.yml`) runs it over the legacy
fixture in `tests/fixtures/legacy-plugin/` and converts that fixture with
`octi plugin convert`.

Authors can run the same check in their own CI:

```ts
import { validatePlugin } from '@octipus/plugin-sdk/testing';
const report = await validatePlugin('./my-plugin');
if (!report.ok) { console.error(report.errors.join('\n')); process.exit(1); }
```

> **Remote install** (`octi plugin install npm:… / github:…`) is a planned
> follow-up; it stays deferred until plugin signing exists, since installing a
> plugin executes third-party code in-process.
