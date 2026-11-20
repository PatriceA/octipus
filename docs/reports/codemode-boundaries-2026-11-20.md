# Codemode boundary tests — 20 November 2026

## Evidence and scope

The restarted server was exercised in an isolated diagnostic conversation,
`cffb6171-c37b-4fd6-a4dd-684f0ea7573d`. Its CLI worker observed 254 tools,
reproduced the Companion error, used the corrected filter, described two tools
with `Promise.all`, and returned visibly truncated output. No existing project
was resumed or changed. This was a live model/bridge smoke test, not a workload
or model-quality benchmark.

Stress cases run the real QuickJS worker-thread sandbox and the CLI HTTP bridge
with synthetic tools. They do not call production services or overload the
running backend. The boundary suite covers discovery, argument shapes, source
and response sizes, storage, aliases, parallel and sequential calls, malformed
requests, timeouts, unavailable timers, output floods and memory exhaustion.

## Companion failure

The recorded script was:

```js
const t = ALL_TOOLS.filter(n => n.startsWith("companion__") || n.includes("companion"));
text(t.join("\n"));
```

`ALL_TOOLS` entries are objects, not strings. The correct form is:

```js
text(ALL_TOOLS.filter(t => t.name.includes("companion")).map(t => t.name));
```

The trace also showed guessed argument names (`goalId` instead of `id`) and an
attempt to use `setTimeout`. Tool instructions now spell out the object shape,
give a filtering example, direct models to `describeTool`, and explain timers
and async filtering.

## Findings and fixes

| Finding | Observed before | Updated behavior |
|---|---|---|
| Zero output budget | `max_output_tokens: 0` returned the entire 114,000-character body because `slice(-0)` means the whole string. | Successful text output is suppressed. A status header remains. |
| Default response | A 114,000-character return entered the response without a default cap. | Default script text is approximately 2,000 tokens / 8,000 characters, visibly truncated. |
| Error response | A thrown error message bypassed the output budget. | Error text and preceding output share a bounded diagnostic; at least 1,000 characters are allowed for error reporting even when output is disabled. |
| Request shape | Arrays, strings, null and missing required fields could reach the host callback. | Non-object arguments and missing top-level required fields fail before tool dispatch. This is not a full JSON Schema validator; tools retain their own validation. |
| Misplaced options | Unknown top-level options and `// @exec:` could be ignored; Markdown fences produced misleading JS errors. | Clear preflight errors explain the supported raw-JS and `// @options:` format. |
| Source size | A 2 MiB script ran in the direct sandbox despite the CLI bridge's independent 1 MiB envelope limit. | A shared 256 KiB UTF-8 source limit fails before launching the VM. The bridge envelope limit still applies independently. |
| Storage key | `store("__proto__", object)` appeared successful but the value disappeared on the next call in the underlying library's serialization. | An install-time compatibility patch changes the library's two serialization dictionaries to objects without prototypes. Global and lexical helper access keep the same namespace. Cross-call persistence, JSON values, deletion and cross-worker isolation are tested. |
| Tool aliases | `ALL_TOOLS` exposed JavaScript-safe names, but `describeTool` looked up only raw names containing punctuation. | Discovery, description and invocation agree on aliases. Sanitized-name collisions receive stable distinct aliases; execution still targets the original authorized handler. |
| Invalid HTTP JSON | The bridge returned a generic server error. | HTTP 400 with `Invalid JSON tool call`; the next valid request still works. |

## Limits verified

| Layer | Limit / observation |
|---|---|
| Source text | 256 KiB UTF-8; exact boundary accepted, one extra byte rejected. |
| CLI HTTP request | 1 MiB for the complete JSON envelope; exact boundary accepted, one extra byte returns 413. |
| Successful text output | Default 2,000 estimated tokens; handler budgets capped at 32,000. Estimate is UTF-16 code units divided by four, not a tokenizer count. Status headers, truncation markers and untrusted-source envelopes add overhead. Selected images use the separate media channel. |
| Worker inline result | After the handler, both native and bridged ToolExecutor paths spill or truncate ordinary successful results beyond 50,000 characters. An explicit large handler budget does not override this later ceiling; a successful spill includes a workspace pointer. |
| Sandbox emissions | Underlying runtime rejects more than 16,777,216 emitted text/image code units or more than 100,000 output items. Returning a large value follows a different runtime path, but Octipus bounds the final text response. Large intermediate values can still be materialized internally; a response budget is not a host-memory quota. Structured returns use compact JSON instead of potentially quadratic indentation, and zero text output skips result formatting. |
| Store | Underlying runtime: 262,144 JSON UTF-16 code units per value, 1,048,576 total including keys. Failed scripts do not commit writes. State belongs to one worker. |
| VM memory | 256 MiB; a generated 300 MiB allocation failed with `out of memory` without terminating the host. This does not cap memory allocated by external tools. |
| Script execution | At most five minutes; callers can shorten with `timeout_ms`. A tight loop was interrupted at the requested 100 ms. Startup/load can also consume the deadline. |
| Tool execution | A script timeout does not prove that an already-started external call was cancelled. Octipus waits for in-flight calls and reports their effects; tool-specific timeouts still matter. |
| Combined calls | Sequential chaining, `Promise.all`, `Promise.allSettled`, 100-call and 1,000-call synthetic batches exercised. No application-level nested-call count cap is established by these tests. Batch production work conservatively; this is not a service-capacity result. |

## JavaScript and serialization boundaries

- `Array.filter(async ...)` does not wait: promises are truthy. Await mapped
  work first, then filter resolved values.
- Await every tool call. An unawaited call may already have effects even if the
  script returns early. Do not infer tool completion from the script's text.
- `Promise.all` rejects on the first failure; other issued calls can still run.
  `Promise.allSettled` makes partial outcomes explicit, but convert rejected
  reasons to `reason.message` when printing: normal JSON serialization renders
  an `Error` as `{}`.
- Tool arguments/results and persistent state cross JSON boundaries. BigInt,
  circular objects, functions and prototypes are not a portable result format.
- There is no `fetch`, `process`, `require`, `setTimeout` or WebAssembly access
  in script code. Use registered tools for I/O and monitoring tools for waiting
  between turns. A promise that cannot settle is rejected explicitly.
- A completed script means its JavaScript completed. Some tools report domain
  errors in a result object; inspect them before claiming successful work.
- `searchTools` and `describeTool` cover callable script tools; coordination
  controls and final tools stay outside scripts. Permissions are still checked
  at each real tool call. Call counts can include attempted calls rejected
  before a host tool executes.

## Repeat the isolated checks

From a source checkout:

```sh
CODEMODE_PROBE_REPORT=/tmp/codemode-probe.json npx vitest run \
  src/tools/codemode.boundaries.test.ts \
  src/tools/codemode.test.ts \
  src/core/cli-tool-bridge.test.ts \
  src/core/tool-executor-codemode.test.ts \
  src/core/cli-agent-bridge.test.ts
```

The optional report contains generated fixture results and sizes, not user data.
The suite uses no live provider credentials. The live smoke observations above
describe the already-restarted server before these boundary fixes; updated code
requires normal activation. No restart was performed during this investigation.
