# @octipus/plugin-sdk

The versioned contract for [Octipus](https://github.com/PatriceA/octipus)
plugins: the `plugin.json` manifest shape, the host API-version compatibility
rule, and a validation kit.

## Contract

```ts
import { PLUGIN_API_VERSION, validateManifest, checkApiVersion } from '@octipus/plugin-sdk';
```

A `plugin.json`:

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "…",
  "apiVersion": "1.0.0",
  "main": "index.ts",
  "capabilities": {
    "tools": [
      { "name": "greet", "description": "…", "parameters": { "name": { "type": "string", "description": "…", "required": true } } }
    ]
  }
}
```

`apiVersion` is a semver contract version. The host refuses a plugin whose
MAJOR differs from `PLUGIN_API_VERSION`, or whose MINOR is newer than the host.
A manifest without `apiVersion` loads with a deprecation warning (legacy).

## Validate in your CI

```ts
import { validatePlugin } from '@octipus/plugin-sdk/testing';

const report = await validatePlugin('./my-plugin');
if (!report.ok) {
  console.error(report.errors.join('\n'));
  process.exit(1);
}
```

`validatePlugin` runs the same pre-flight the host runs at load time: manifest
schema, apiVersion compatibility, module shape, an `initialize` dry-run against
a mock context, and a fixture dry-run of every declared tool. Tool dry-run
failures are **warnings** (a tool may legitimately reject synthetic input);
`ok` is false only on fatal errors.

Or from the CLI: `octi plugin validate ./my-plugin`.
