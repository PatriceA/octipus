# Context hooks

Context hooks put the user's own knowledge in front of an agent before it
starts, so the agent does not have to think of searching for it. They run
before every root turn and before every specialist, swarm child and directly
spawned agent that works on a user's task (the full list is under
[Where hooks run](#where-hooks-run)). In the settings and the API this is the
`recall` module ([MODULES.md](MODULES.md)).

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
| Knowledge recall | `recall` | each message, each specialist | The passages of the user's knowledge base and notes that qualify for the message (or the specialist's brief): at most 4, one per source, within 1200 tokens. Nothing when no passage qualifies. |
| Notes index | `notes_index` | each message | The number of notes, the titles of the pinned ones, then the most recently changed (15 titles, 150 tokens). Tells the agent what there is to look up. |

A user can add hooks of their own on the **Recall** page (`/recall`):

- **Context note** (`note`): the body of one note, every time. It is a place
  for standing context such as "who I am, what my company does, answer in
  Dutch", and works like a `CLAUDE.md`. The note is picked from the user's
  notes by title (stored as its `slug`).
- Another `recall` or `notes_index` hook with different settings.

All hooks of one agent start run at the same time and share
`contextHooks.maxTokens` (default 2000, enough for every default together).
The budget is spent in list order (built-ins first): a block that no longer
fits is left out (recorded as `skipped`, `budget_spent`). A hook that fails or
is not done 4 seconds after the start began (`HOOK_TIMEOUT_MS`, listing the
hooks included) is left out of that start. Committing what is shown (below)
must end by 4.5 seconds (`START_DEADLINE_MS`), so an agent start waits for its
hooks at most that long; the turn record is written after, without holding it
up. The agent still starts.

## Where hooks run

Every path that starts an agent on a user's message or brief goes through one
function, `contextForAgentStart` (`src/core/context-hooks/agent-start.ts`),
which also applies the audience rule below. A test
(`spawn-sites.test.ts`) reads every `agentManager.spawn(` and
`directResponse(` call in `src/`, and every `.run(` on an agent taken from
the manager (`agentManager.get(…)`), and fails when one is neither hooked
nor listed as exempt with its reason, so a new start path cannot be added
without deciding. An admin who messages another user's live agent gets no
hooks: the owner's knowledge is not pushed into a reply someone else reads.

| Start | Event | Searched with | Where the block goes |
|---|---|---|---|
| A root turn: chat, a channel, a heartbeat or scheduled turn | `turn_start` | the message (a short one with the previous typed message) | the turn's per-turn context, sent with the message |
| Plan execution ("go" on a plan) | `turn_start` | the plan brief | the same |
| A side question (`chat.interject`) | `turn_start` | the question (a short one with the previous typed message) | `directResponse`'s per-turn context |
| A specialist (`spawnWorker`, pipeline stages included) | `worker_start` | task and input | the volatile part of its system prompt |
| A swarm child (`spawn_child`) | `worker_start` | its brief | its first message; every retry reruns that message |
| A hook's spawned agent, `POST /api/agents` with a message | `worker_start` | the message | before the message |
| A new task for a live agent (`POST /api/agents/:id/message`), sent by its owner | `worker_start` | the message | before the message |

The model is chosen after the hooks ran, so a passage at protection level 3-4
puts the agent on a local model, or refuses the start with the reason when
none is bound ([PROTECTION-LEVELS.md](PROTECTION-LEVELS.md)). `POST /api/agents`
runs the hooks before it spawns; a side question picks its model after them;
a hook's agent is spawned when the hook fires (so a refusal for capacity
fails the action at once) and, when its hooks then raise the session to a
local-only level, is spawned again before it runs.

Deliberately not hooked:

- **The voice planning reply.** It is spoken on the fast voice model, where
  the hooks' deadline would be heard. The confirmed turn that follows is an
  ordinary turn and is hooked.
- **Retry and backup respawns** of a failed specialist. They rerun the prompt
  `spawnWorker` already assembled, block included.
- **A fork child.** It carries its parent's conversation, which already holds
  the parent's blocks, so it gets none of its own (unless an attempt runs as
  an ordinary child).

## How a passage qualifies

Recall searches the knowledge base in two legs at once: by meaning (the
query's embedding, cosine similarity) and by keyword (chunks sharing at least
one word of the query, any word). Sharing a word is not evidence of
relevance, so a candidate is shown only when it qualifies under one of three
rules:

1. **Similarity**: its cosine similarity reaches `minSimilarity` (0.45).
2. **Coverage**: it contains at least `keywordCoverage` (0.6) of the query's
   distinctive words, and at least two of them. When the query has an
   embedding the passage also needs a cosine of at least 0.6 × `minSimilarity`.
3. **Identifier**: it contains, as a whole token, an identifier from the
   query: something a person would call a reference. Letters and digits in
   one word with at least three digits (`E1234`, `sha256`); groups joined by
   `-`, `.`, `/`, `_`, `:` or `#` that start with a letter and have three
   groups or three digits (`INV-2024-118`, `v2.3.1`, `PO-4500`); three digit
   groups or more (`2.3.1`, `10.0.0.1`); a bare number of six digits or more
   (`4500012345`). Not a year, a time, an amount, a date, an ordinal or a
   name like `covid-19`: those hold digits but turn up in passages about
   anything. A ticket key with two digits (`OCT-42`) is not one either; it
   shares its shape with `covid-19`. An identifier match needs no cosine:
   cosine scales differ per embedding model, and the exact reference is the
   stronger evidence.

"Distinctive" is four characters or more, or holding a digit. It stands in for
a stopword list, since the keyword index uses the English text-search
configuration and a Dutch or German message keeps its stopwords.

Then the **relative cut**: a passage that qualified on similarity alone and
lies more than `maxGap` (0.15) below the best such passage is dropped. It only
ever removes; a passage that covers the query or names its identifier stays
whatever its cosine. At most `limit` passages are kept, one per source.

The record of each run says which rule each shown passage qualified under
(`qualifiedBy`); the Recall page counts them per hook.

### The query

What recall searches (`buildRecallQuery`, `src/core/context-hooks/recall.ts`):

- **A follow-up keeps its subject.** For a root turn or a side question the
  user typed, a message with fewer than four distinctive words is searched
  together with the previous message the user typed in this session (their
  own words only, nothing from before a clear, at most 500 characters of it):
  "and for enterprise?" after "What do we charge for a website?". The message
  is searched on its own first, and its own passages come first: a short
  question on a new topic ("What is our refund policy?") is not steered by
  the one before. Only when that leaves slots free are the two searched
  together, to fill them; a passage from that second search must hold a
  distinctive word of the new message (or its identifier), identifiers come
  from the new message only, and the excerpt is steered by the new message's
  words first. The second search costs one more embedding call for such a
  message, inside the same deadline. There is no model call: recall does not
  add a model round trip to every turn.
- **A short message.** A message of fewer than two content words is skipped
  (`short_message`), unless an earlier typed message is there and the message
  names something itself: a distinctive word that is not an acknowledgement
  ("Enterprise?", "INV-2024-119?"), or two characters or more of a script
  written without spaces ("企业版？"). A message made only of acknowledgements
  ("ok", "thanks", "yes please", "谢谢") is never searched, earlier message or
  not. "why?" names nothing and stays skipped.
- **A long message keeps its head and its tail**, 2000 characters in all (the
  first 500 and the last 1500, cut on whitespace): after a pasted log or
  document, the question is usually at the end.
- Workers and children are searched with their brief (task plus input) under
  the same trimming, never with an earlier message.

### The excerpt

Each passage shows up to `excerptChars` (1000) characters. That is the
indexers' largest chunk, so a chunk is normally shown whole and keeps the
same bytes whichever question found it. A longer chunk (indexed before long
paragraphs were split) shows the window that holds the most words of the
query, not its first characters. A cut is marked with "…". The label line gives the kind (note or document), the
title, the section and the age of a passage over a month old; never a score
or a position, so the same passage keeps the same bytes from turn to turn.

## A passage is not sent twice

Each passage is its own repeatable part of the recall block. On a later turn
of the same conversation, a passage that is still in view (an earlier message
the model still sees carries it) is left out of what is sent; a new passage
is sent. When every passage of a turn is still in view the whole block is
left out, and a one-line note says that the context above still applies.
When the conversation is compacted within a turn, the passages left out are
put back. Limits:

- A chunk longer than `excerptChars` shows a window that depends on the
  query, so the same chunk found by a different question can show a
  different part of it. That is new text and is sent. With the defaults
  only chunks indexed before long paragraphs were split are that long.
- A part under 120 characters is always sent again: it is too short to be
  recognised safely in earlier messages.
- In view means the same passage as a whole: a passage edited so that it
  is now the start of its earlier copy (its last sentence removed) is new
  text and is sent.
- Side questions resend their passages: `directResponse` has no cross-turn
  omission.

The turn's record lists every passage recall chose for the turn, whether it
was sent or left out as still in view (see [Measurement](#measurement)).

## Side effects only for what is shown

Showing a passage raises the session's protection level to the passage's
document's level and counts an access on the passage. Both happen only for a
block that is actually shown: after the deadline and the shared budget, and
before the agent starts (the session must hold the level of what it was given
before it can pass it on). A block dropped for the budget, or a hook that
timed out and finishes later, leaves nothing behind but its run record. A
specialist or a swarm child can still be refused after its hooks ran (the
concurrency limit, a quota, the space check): its passages count as read only
once the agent has started, but the level stays raised, since it has to be
raised before the model is chosen and raising it for a passage no model saw
is the safe direction. When
raising the level fails or is not done by the start deadline, the block is
left out (`error`, `commit_failed`) and its tokens go back to the shared
budget: a later block left out for the budget is considered again. The
embedding request of a hook cut off by its deadline cannot be cancelled (the
provider clients take no abort signal), but recall does not search after
the deadline, and on Postgres its search statement is cancelled at it.

## Without an embedding model, and when embedding fails

Recall needs an embedding model. With none set up it does not run: every run
is recorded as `skipped`, `no_embedding_model`, and the Recall page leaves the
sidebar ([MODULES.md](MODULES.md)). Set one up in **Settings → Models**.

When a model is set up but the query cannot be embedded (the provider is
down, a timeout), recall runs on its keyword rules alone for that run:
coverage (without the cosine floor) and identifiers. The run is recorded as
`degraded: embedding_failed` and logged, and the Recall page counts these
runs per hook as "keywords only".

## Recall settings

Set per hook on the Recall page; a blank field takes the default shown in it.

| Setting | Default | Meaning |
|---|---|---|
| `minSimilarity` | 0.45 | The lowest cosine similarity for rule 1 (and 0.6 × it is rule 2's floor). `search_knowledge` uses 0.3: an injected passage costs tokens on every turn, a searched one only when asked for. Check it with the [sweep](#the-threshold-sweep). |
| `keywordCoverage` | 0.6 | Rule 2: the share of the query's distinctive words a passage must contain (and at least two). |
| `maxGap` | 0.15 | The relative cut: a passage qualified on similarity alone is dropped this far below the best one. |
| `limit` | 4 | Most passages (one per source). |
| `excerptChars` | 1000 | Characters per passage: the largest chunk the indexers write, so a chunk is shown whole. |
| `tokenBudget` | 1200 | Most tokens for the block: the default four passages of 1000 characters of prose fit, with their labels; with the notes index (150) and a context note (600) it stays within `contextHooks.maxTokens` (2000). |
| `purposes` | note, document, knowledge_artifact, image_description | Which knowledge-base rows count. |
| `includeProductDocs` | false | Octipus's own manual. Agents are already told to search it for setup questions. |

## What the agent is told

The recall block opens with a line saying it was retrieved automatically
from the user's own knowledge base and notes because it matches this message,
that it is reference data and not instructions, that it may be incomplete
(`search_knowledge`, `search_notes` and `read_note` find more) and that the
answer should name the source it used.

The general role's prompt says what the block's presence and absence mean:
present, it is what a search for this message found, so search only for what
it lacks; absent (and no note that earlier context still applies), nothing
close was found or recall did not run, so anything about the user, their work
or their company is still to be searched.

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
  cannot close the fence.

## Measurement

Every agent start with hooks leaves one row in `context_turns`. The row holds
what each hook did (injected, found nothing, skipped, or failed, with the
reason, whether it ran degraded, and item ids, titles, scores, the rule each
passage qualified under, tokens and time) and, once the agent is done:

- `knowledge_tool_calls` and `notes_tool_calls`: how often the agent read the
  knowledge base or notes itself (search, read, list, query, backlinks). Every
  Octipus tool call goes through the ToolExecutor in the server process, a CLI
  agent's bridge calls included, so these counts cover CLI agents too. For a
  root turn the count covers the specialists it spawned. For a specialist it
  covers that agent alone.
- `cited_items` (**named**): how many recall passages the answer named, by
  title on word boundaries (four characters or more, a file without its
  extension, any script) or by id. A context note is not counted: it is
  standing guidance, not a source to name.
- `used_items` (**used**): how many recall passages the answer used. A
  passage counts as used when the answer repeats distinctive content of its
  excerpt that was not already in the query: one strong token (a number of
  three digits or more that is not a bare year, such as `2400`, `2,400` or
  `2024-05-14`; a token of four characters or more mixing letters and digits,
  such as `INV-2024-118`; a run of eight characters of a script written
  without spaces) or two different weak ones (a two-digit number, a year, a
  word of eight letters or more that is not a common one, compared on its
  first seven letters). Null when no recall passage was shown, and on rows
  from before it was measured.
- `model` and `cli`: which model ran and whether it was a vendor CLI.

For a root turn or a side question the answer is the reply; for a
specialist, a swarm child or a directly spawned agent it is its result text.
A turn that failed or was cancelled has no answer: it stays in the
denominator, as neither named nor used.

The row never stores the message, the passages or the answer: the excerpts
and the query are kept only in memory, on the turn handle, until the turn is
finished.

`GET /api/context-hooks/stats?days=30` and the **Recall** page turn those
rows into:

| Number | Read it as | What it cannot tell you |
|---|---|---|
| answers naming a recalled passage | Of the finished turns where recall showed passages, how often the answer named one. | Agents rarely name sources unless asked: a low number does not mean the passages were ignored. |
| answers using a recalled passage | Of the same turns, how often the answer repeated a number, code or uncommon word from a passage that the question did not hold. | It misses a passage that informed the answer in other words, and an answer can repeat a number that came from elsewhere. It counts passages chosen for the turn, also those left out as still in view from an earlier turn; a passage still in view that recall did not choose this turn is not counted. |
| KB or notes searched by a tool call | How often agents still went looking. For a message this counts the specialists the agent spawned too. | Searching after recall is not a failure: the passages may have pointed at more. |
| searched after recall found nothing | High: recall is missing things the agent then found itself. | Low is also what an agent that never searches looks like. |
| per event | Messages (root turns, plan runs, side questions) apart from specialists and swarm children. | Side questions and plan runs are not separated from ordinary turns. |
| per model, CLI apart | Whether one model or vendor CLI ignores what it is given. | |
| per hook | Runs injected, found nothing, skipped and failed; runs degraded to keywords; blocks dropped for the shared budget or a failed commit; the rules shown passages qualified under; average tokens, time, and best similarity (over passages shown on similarity only: a keyword-only passage has a score of 0). | |

Both "named" and "used" count turns, not passages: a turn counts when at
least one passage was named or used. Rows from before named was limited to
recall passages may count a context note named.

The page also warns when long-term memory is not being filled, and says why:
no model on the `background` topic (it extracts and judges facts), no
embedding model (it stores them), or `memory.extractionCadence` set to `off`.
Every turn then gets an empty memory block, which looks the same as "the agent
ignores memory".

### Calibration

One fixed `minSimilarity` does not suit every embedding model: their cosines
sit in different ranges. The stats flag a recall hook whose bar looks wrong:

- **injects on nearly every message**: passages were found on 95% or more of
  the runs that searched (likely too low: passages that do not help cost
  tokens on every turn);
- **injects almost never**: on 5% or fewer (likely too high for the model, if
  the notes cover what is asked).

Only runs that searched on the bar count: not a skipped run (a short message,
no embedding model), not a failed or timed-out one, not one degraded to
keywords. A block found and then dropped for the budget or a failed commit
counts as found. No warning is given under 30 such runs: a day spent on one
project looks like a wrong bar. The warning points at the sweep.

### The recall eval

`POST /api/context-hooks/eval` (and the form on the Recall page) runs a list of
questions through the recall selection against the caller's own knowledge
base, with no model call, at the Knowledge recall hook's settings. What it
scores is exactly what the hook would inject. Each question names what the
answer is in: a note title, a file name, a source id or a phrase from the
passage. A question with nothing expected should find nothing.

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
that should find nothing and got nothing).

On the page, write one question per line: `question => expected; other`, or
`question => -` for a question that should find nothing.

### The threshold sweep

`POST /api/context-hooks/eval/sweep` (the **Sweep thresholds** button) runs
the same cases at `minSimilarity` 0.20 to 0.80 in steps of 0.05, or at up to
21 values given as `thresholds`, with the hook's other settings. Each
question is searched, and embedded, once; the selection is then applied at
every value without further I/O. 100 cases at most, as for the eval.

It returns `found`, `abstained` and `mrr` per value and a `recommended` value:
the one with the highest found-rate plus abstained-rate, a tie going to the
higher value (it shows less for the same score). There is no recommendation
(`reason`):

- `needs_both_kinds`: the cases need both answerable questions and questions
  that should find nothing. With one kind only, the lowest or the highest
  value always wins.
- `embedding_failed`: a question could not be embedded (`degraded` says how
  many), so the bar was not applied to it.

On the page the recommended value can be applied to the Knowledge recall hook
in one click; its other settings are kept. The recommendation is only as good
as the questions: use questions you actually ask, about a dozen or more of
each kind.

## API

All routes are personal: they read and write only the caller's hooks and rows.
The eval and the sweep search the knowledge base of the caller's own
workspace (not a space's) and answer 409 `capability_not_configured` without
an embedding model.

| Method | Path | |
|---|---|---|
| GET | `/api/context-hooks` | The install switch, the token budget, and the caller's hooks (built-ins as `builtin:<key>`). |
| POST | `/api/context-hooks` | Add a hook: `{ name, kind, events?, config?, enabled? }`. At most 20. |
| PATCH | `/api/context-hooks/:id` | Change `name`, `events`, `config` or `enabled`. A hook keeps its kind. `config` replaces the stored settings: send the ones to keep. |
| DELETE | `/api/context-hooks/:id` | Delete a hook of one's own. For a built-in, put it back to its default. |
| GET | `/api/context-hooks/stats?days=` | The numbers above (1 to 90 days, default 30; older rows are pruned with the log tables). Over 5000 agent starts in the window, they cover the newest 5000 and `sampled` is true. |
| POST | `/api/context-hooks/eval` | The recall eval (1 to 100 cases; optional `minSimilarity`, `limit`). |
| POST | `/api/context-hooks/eval/sweep` | The threshold sweep (1 to 100 cases; optional `thresholds`, 1 to 21 values between 0 and 1, and `limit`). |

Events are `turn_start` (before the root agent answers, a plan run or a side
question) and `worker_start` (before a specialist, a swarm child or a directly
spawned agent). The response shapes are in `src/shared/context-hooks.ts`.

## Known limits

- **Other languages.** The keyword index uses the English text-search
  configuration: words of other languages are not stemmed, and their
  stopwords are kept (the four-character rule keeps most out of coverage). A
  per-language configuration needs a migration and a reindex.
- **No query rewrite.** A follow-up is joined with the previous message, not
  rewritten by a model; a follow-up of three letters ("Bob?") or one that
  refers to the agent's reply rather than the user's own message keeps no
  subject.
- **Swarm children get no long-term memory**, only the context hooks.
- **Side questions resend their passages** (no cross-turn omission).
- **Used is a heuristic.** See [Measurement](#measurement).

## Settings

| Key | Default | |
|---|---|---|
| `contextHooks.enabled` | `true` | Install-wide switch (`CONTEXT_HOOKS_ENABLED`). Off: no hook runs and nothing is measured. |
| `contextHooks.maxTokens` | `2000` | Most tokens the hooks of one start may inject together (`CONTEXT_HOOKS_MAX_TOKENS`). |

## Code

- `src/core/context-hooks/agent-start.ts`: `contextForAgentStart`, the one entry point, and the audience rule.
- `src/core/context-hooks/recall.ts`: recall's pure rules (qualification, the relative cut, the query, the short-message rule, the excerpt).
- `src/core/context-hooks/kinds.ts`: the three kinds and their settings; `searchRecall` and `choosePassages`, shared by the hook, the eval and the sweep.
- `src/core/context-hooks/store.ts`: built-ins and the user's hooks (`context_hooks`).
- `src/core/context-hooks/run.ts`: running them, the shared budget, the commit step, the turn record (`context_turns`).
- `src/core/context-hooks/measure.ts`: named, used, calibration and the sweep's recommendation (pure).
- `src/core/context-hooks/tool-usage.ts`: the knowledge and note read counter fed by the ToolExecutor.
- `src/core/context-hooks/stats.ts`: the stats, the eval and the sweep.
- `src/core/context-hooks/spawn-sites.test.ts`: every agent start hooked or exempt.
- `src/shared/context-hooks.ts`: the response shapes and the recall defaults, shared with the web page.
