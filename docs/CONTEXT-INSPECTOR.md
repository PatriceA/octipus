# Context inspector

The **Context** panel in the web chat's right-hand column shows what the root
agent's latest request was made of: how much of the model's context window it
used, which part took how much, and — for the latest turn — the text the model
actually read.

## What it shows

- **Fill.** Estimated tokens of the latest request against the model's context
  window (`~64.8k of 200k · 32% full`). When the model registry does not know
  the window, the bar shows each part's share of the request instead and says so.
- **Categories.** Every part of the request is in one of nine fixed categories,
  each with its own colour:

  | Category | What is in it |
  | --- | --- |
  | Guardrails & formatting | Security preamble, output formatting, vault guidance, interactive-answer rules, a security alert when the input guard flagged the message |
  | Role & persona | The role prompt (`general` for the root, or the Companion supervisor prompt) and your persona |
  | Delegation | The delegation policy and, on the full tier, the delegation guide |
  | Workspace | Dev-mode project (with the first 500 characters of `AGENTS.md`), the repo map, the workspace folder listing, a shared-space notice |
  | Tool definitions | The JSON schema of every tool advertised to the model (largest ten listed, the rest folded), the MCP servers section, tool groups left out for a small model |
  | Skills | Skills selected for the session |
  | Turn context | Date and time, long-term memory, each context hook, shared-space and group context, attachments, per-turn directives (topic hint, output directive, plan mode) |
  | Conversation | The checkpoint summary, earlier messages, assistant replies with their tool calls, tool results (with the largest one named), and your new message |
  | Other | Any prompt text that was not tagged with a category. It is shown, not hidden, so nothing goes unaccounted for |

- **Caps.** A section cut to fit its budget is marked *at cap* or *truncated*,
  with the cap: the repo map (`REPO_SUITE_TOKEN_BUDGET`), `AGENTS.md` in dev mode
  (500 characters).
- **Where it sits.** Each section says whether it is part of the *cached prefix*
  (the same every turn until something in it changes), *sent every request*
  (tool schemas), *this turn* (rebuilt for each message) or *history*.
- **Text.** *Read* opens the text of a section as the model received it.
- **Provider count.** The input tokens the provider reported for the same
  request (from `cost_log`), and how many of them came from its prompt cache.
- **Growth by turn.** Request size for the last 40 measured turns, split into
  prefix + tools, this turn and history, so a compaction shows as a drop.
- **Compact conversation** sends `/compact` (see [CHAT-COMMANDS.md](CHAT-COMMANDS.md)).

## How it is measured

All sizes are **estimates**: characters ÷ 4, the heuristic used by the rest of
the prompt accounting (`src/core/agent/prompt-budget.ts`). Providers tokenise
differently, which is why the provider's own count is shown beside it rather
than replacing it.

The root agent's request is assembled in three places, so it is measured in
three steps (`src/core/agent/prompt-composition.ts`):

1. **Root runner** (`root-runner.ts`) tags every part it pushes into the static
   and volatile tiers with a category and a label, and stages them for the
   session. The role's base prompt is split on the real `SECURITY_PREAMBLE`,
   `OUTPUT_FORMATTING_RULES` and `VAULT_USAGE_GUIDANCE` constants
   (`prompt-parts.ts`); the turn context is split into the pieces `service.ts`
   built it from. A part pushed without a tag is resolved as *Other*, labelled by
   its first line, and a unit test fails if a push site in the root runner skips
   the tagger.
2. **Agent manager** (`agent-manager.ts`) applies the same module filter to the
   staged parts, adds the MCP servers section and the selected skills, and binds
   the result to the agent it spawned.
3. **Worker** (`agent-worker.ts`), when it adds the turn's user message — the
   moment system messages, advertised tools and the history loaded under the
   session lock all exist — measures the whole request once.

A **worker** (spawn_child, heartbeat role agent, pipeline stage) is measured the
same way: the agent manager stages its system prompt split at the volatile
marker (role prompt as the static prefix, the per-run date, profile, memories
and workspace as turn context) plus MCP servers and skills, and the worker
measures it with its brief as the user message and no history. Its sizes go on
its agent row (`agents.metadata.promptComposition`); its text stays in memory
for the 200 most recently measured workers. The [run view](MISSION-CONTROL.md#run-detail)
shows it.

## What is stored

- The **sizes** (category, tier, label, characters, estimated tokens, cap
  status and note per section) are stored with the turn's user message, as
  `messages.metadata.promptComposition`. No prompt text is stored.
- The **text** of the latest measured turn is kept in memory, for the 50 most
  recently measured sessions. After a restart — or when the turn ran in another
  process — the panel shows sizes and says the text is not available until the
  next message.

`GET /api/sessions/:id/context` returns both. It follows the session-usage
rule: the session's owner only. A room member or an admin gets *not found*.

## Not measured

- Forked workers, seeded with their parent's conversation, and CLI-model workers.
- CLI-model root turns, which build their own prompt, and casual direct replies
  that skip the agent loop.

A session with no measured turn says *Not measured yet* rather than showing zero.
