# Context hooks

Context hooks put the user's own knowledge in front of an agent before it
starts, so the agent does not have to think of searching for it. They run
before every root turn (a chat message, a channel message, a heartbeat or
scheduled turn) and before every specialist or role agent. Their output goes
in the per-turn part of the system prompt, beside the long-term memory block.

## Why

Agents are told to check the knowledge base, but they mostly don't. CLI agents
are the worst case: Claude Code and Codex have their own file search and web
search, and they reach for those before an Octipus tool. A tool the model has
to decide to call is unreliable however the prompt is worded. Content that is
already in context is used. The same approach is common for Claude Code and
Obsidian vaults: a `UserPromptSubmit` hook searches the vault with each prompt
and injects the closest notes, and a `SessionStart` hook injects an index of
the vault. Context hooks do this inside Octipus, so it works the same way for
every agent and every provider, with no hook setup per vendor CLI.

## The hooks

Every user starts with two built-in hooks, both on:

| Hook | Kind | Runs before | What it injects |
|---|---|---|---|
| Knowledge recall | `recall` | each message, each specialist | The passages of the user's knowledge base and notes closest to the message (or the specialist's brief): at most 4, one per source, within 700 tokens. Nothing when no passage is close enough. |
| Notes index | `notes_index` | each message | The number of notes, the titles of the pinned ones, then the most recently changed (15 titles, 150 tokens). Tells the agent what there is to look up. |

A user can add hooks of their own on the **Recall** page (`/recall`):

- **Context note** (`note`): the body of one note, every time. It is a place
  for standing context such as "who I am, what my company does, answer in
  Dutch", and works like a `CLAUDE.md`. Set its `slug` to the note's slug.
- Another `recall` or `notes_index` hook with different settings.

All hooks of one turn share `contextHooks.maxTokens` (default 1200). They run
in list order (built-ins first). A hook that fails or takes longer than 4
seconds is left out of that turn. The agent still starts.

### Recall settings

| Setting | Default | Meaning |
|---|---|---|
| `minSimilarity` | 0.45 | The lowest cosine similarity a passage needs, unless it matched every word of the message by keyword. `search_knowledge` uses 0.3: an injected passage costs tokens on every turn, a searched one only when asked for. |
| `limit` | 4 | Most passages (one per source). |
| `tokenBudget` | 700 | Most tokens for the block. |
| `excerptChars` | 700 | Characters per passage. |
| `purposes` | note, document, knowledge_artifact, image_description | Which knowledge-base rows count. |
| `includeProductDocs` | false | Octipus's own manual. Agents are already told to search it for setup questions. |

Without an embedding model, recall matches by keyword only (every word of the
message must be in the passage), so it injects much less. Set up an embedding
model in **Settings → Models** for it to work as intended.

A message with fewer than two words of three letters or more ("ok",
"thanks!") is not searched.

## What reaches whom

- Recall reads the turn's knowledge scope, the same rows `search_knowledge`
  would return for that agent: the user's own, in a space the space's (a
  guest's folders only), plus product docs when switched on. Repository
  artefacts are left out.
- The notes index and context notes read personal notes only (the turn's
  workspace and user-level notes), and never run in a space.
- No hook runs where other people read the reply (a group-channel thread, a
  room), or in a session whose text may not be copied anywhere (asking your
  agent in a space on another install).
- Injected text is fenced (`<recalled-knowledge>`, `<notes-index>`,
  `<context-note>`). Angle brackets in the content are replaced, so a passage
  cannot close the fence. The recall block tells the agent that it is
  reference data, not instructions.

## Measurement

Every agent start with hooks leaves one row in `context_turns`. The row holds
what each hook did (injected, found nothing, skipped, or failed, with item
ids, titles, scores, tokens and time) and, once the agent is done:

- `knowledge_tool_calls` and `notes_tool_calls`: how often the agent read the
  knowledge base or notes itself (search, read, list, query, backlinks). Every
  Octipus tool call goes through the ToolExecutor in the server process, a CLI
  agent's bridge calls included, so these counts cover CLI agents too. For a
  root turn the count covers the specialists it spawned. For a specialist it
  covers that agent alone.
- `cited_items`: how many injected sources the answer named, by title (four
  characters or more, a file name without its extension) or by id.
- `model` and `cli`: which model ran and whether it was a vendor CLI.

The row never stores the message or passage text.

`GET /api/context-hooks/stats?days=30` and the **Recall** page turn those
rows into:

| Number | Read it as |
|---|---|
| answers naming an injected source | Recall gave the agent something it used. |
| searched the KB or notes themselves | How often agents still went looking. |
| searched after recall found nothing | High: recall is missing things the agent then found itself. Lower `minSimilarity`, and check with the eval. |
| per model, CLI apart | Whether one model or vendor CLI ignores what it is given. |
| per hook | Injected, found nothing, skipped and errors, average tokens, time and best match. |

The page also warns when long-term memory is not being filled, and says why:
no model on the `background` topic (it extracts and judges facts), no
embedding model (it stores them), or `memory.extractionCadence` set to `off`.
Every turn then gets an empty memory block, which looks the same as "the agent
ignores memory".

### The recall eval

`POST /api/context-hooks/eval` (and the form on the Recall page) runs a list of
questions through the recall search against the caller's own knowledge base,
with no model call. Each question names what the answer is in: a note title,
a file name, a source id or a phrase from the passage. A question with nothing
expected should find nothing.

```json
{
  "cases": [
    { "question": "What do we charge for a website?", "expect": ["Pricing"] },
    { "question": "What is the capital of France?", "expect": [] }
  ],
  "minSimilarity": 0.4
}
```

It returns, per question, the passages that would be injected and the rank of
the expected one. Overall it returns `found` (answerable questions whose
source was injected), `mrr` (mean reciprocal rank) and `abstained` (questions
that should find nothing and got nothing). Run the eval at a few values of
`minSimilarity` and keep the one with the best balance between the two, then
set it on the Knowledge recall hook.

On the page, write one question per line: `question => expected; other`, or
`question => -` for a question that should find nothing.

## API

All routes are personal: they read and write only the caller's hooks and rows.

| Method | Path | |
|---|---|---|
| GET | `/api/context-hooks` | The install switch, the token budget, and the caller's hooks (built-ins as `builtin:<key>`). |
| POST | `/api/context-hooks` | Add a hook: `{ name, kind, events?, config?, enabled? }`. At most 20. |
| PATCH | `/api/context-hooks/:id` | Change `name`, `events`, `config` or `enabled`. A hook keeps its kind. |
| DELETE | `/api/context-hooks/:id` | Delete a hook of one's own. For a built-in, put it back to its default. |
| GET | `/api/context-hooks/stats?days=` | The numbers above (1 to 365 days, default 30). |
| POST | `/api/context-hooks/eval` | The recall eval (1 to 100 cases; optional `minSimilarity`, `limit`). |

Events are `turn_start` (before the root agent answers) and `worker_start`
(before a specialist or role agent starts).

## Settings

| Key | Default | |
|---|---|---|
| `contextHooks.enabled` | `true` | Install-wide switch (`CONTEXT_HOOKS_ENABLED`). Off: no hook runs and nothing is measured. |
| `contextHooks.maxTokens` | `1200` | Most tokens the hooks of one turn may inject together (`CONTEXT_HOOKS_MAX_TOKENS`). |

## Code

- `src/core/context-hooks/kinds.ts`: the three kinds and their settings.
- `src/core/context-hooks/store.ts`: built-ins and the user's hooks (`context_hooks`).
- `src/core/context-hooks/run.ts`: running them, the turn record (`context_turns`), citation.
- `src/core/context-hooks/tool-usage.ts`: the knowledge and note read counter fed by the ToolExecutor.
- `src/core/context-hooks/stats.ts`: the stats and the eval.
- Called from `src/core/agent/service.ts` (root turns) and `src/core/agent/worker-spawner.ts` (specialists).
