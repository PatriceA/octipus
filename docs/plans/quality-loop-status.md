# The quality loop: what the brief asked, what is done, what is next

Status as of 2026-08-02. Every claim below is either a commit SHA, a command
output, or explicitly marked as unverified. Where something was *not* done, it
says so plainly rather than being folded into a neighbouring item that was.

## Where main stands

| | |
|---|---|
| main | `8d218063` |
| CI | all 7 workflows green |
| Backend tests | 3629 pass / 0 fail / 175 skip |
| Web E2E | green · Integration green · CodeQL green · Semgrep green |
| Coverage | 52.54% lines / 61.29% functions (floor 52.30%) |
| Providers | all healthy except `grok` (holds no topic role — nothing routes there) |

## Scorecard against the original brief

### Done, with evidence

| Ask | Status | Evidence |
|---|---|---|
| Everything on main, no PRs, merge direct | done | 4 commits merged ff-only this session |
| The 14-minute delivery lag — *why?* | **root-caused and fixed** | toolshim burned a turn after the answer was written (`a0e9ff5e`, `675d71d2`); `scripts/run-health.ts` measures `deliveryLag = complete − last assistant text` so it cannot regress unnoticed |
| Silence is unreadable | done | `27dd9477` — a blocked worker now names what it waits on every 20s (`agent.blocked`) |
| "resume.md, implement all open points" — what would octipus do? | **measured, and it was bad** | It built a 7-stage pipeline, marked all 7 green, and wrote **zero files**. Fixed by `131ff1bc`: a stage that declares it produces artifacts and changes nothing now fails |
| Pipelines report green over empty workspace | done | `131ff1bc` + Phase B counters for CLI-backed stages |
| Fail fast when a local model can't fit | done | `27dd9477` — gates on live `MemAvailable`, fails open on uncertainty |
| Notes: images by paste/drop/picker | done | `f3fd8436` |
| Notes: links | done | `[[wikilinks]]`, backlinks, link suggestions in `src/tools/notes` |
| MCP set up correctly | verified | all providers healthy via `octipus_health_models` |
| E2E tests exist | verified | 20+ suites in `scripts/e2e/tests/`, 64 web E2E, 141/142 API e2e |
| TUI as test ground | available | `src/tui-pi`, `src/tui-editor`, `bun run test:tui` |
| Features as last resort | followed | this session shipped no new user-facing feature |

### Not done — and these are the two the brief made *measurable*

**1. Nobody has verified the planner→executor split actually saves money.**

Phases 1–4 shipped (`#259`–`#262`, `b8fa63bb`, `7cda1a5e`, `ad938fb8`): a plan
routes a child to the cheap executor and it runs mechanically. But the brief's
actual requirement was sharper than "it routes":

> *"Make sure it is like that, and not the 'big' model actually did all the work
> beforehand (planned in such detail that doing it would be nearly no
> difference) and the local model just uses a few tokens to run 5 commands."*

`grep` over `eval/*.yaml` for `planner|executor` returns **nothing**. There is no
measurement of the token split, so the one thing the brief asked to be sure of
is precisely the thing not evidenced. The routing works; whether it *saves* is
unknown.

**2. There is no benchmark, so there is no loop.**

> *"After you get a baseline, set a benchmark which fits our goal and
> loop/improve/test/fix till this goal is reached."*

What exists: `eval/*.yaml` (capability pass/fail), `scripts/run-health.ts` (one
dimension — delivery lag), `coverage-baseline.json` (a ratchet, not a quality
measure). What does not exist: a single scored baseline with a target to loop
against. Work so far has been defect-driven — find a real failure, fix it —
which is honest and has produced real fixes, but it is not the measurable loop
that was asked for, and it has no stopping condition.

### Not done — scenarios never run

Three of the brief's scenarios were never exercised, so we have no idea how
octipus handles them:

- **Hermes-style install UX.** "Installation of Hermes sucks, but is optically
  nice — see how to improve octipus." No install-UX work in history.
- **"One UI over 3 existing tools, end2end, with test coverage."** Never run.
- **Trip planning** (3 days, car, dog, food, walks, nature). Never run. This is
  the only non-coding scenario in the brief and therefore the only test of
  whether octipus is a general assistant or just a coding agent.

### Partially covered — capability targets from the user stories

The Hermes/openclaw stories are *capability targets*, not defects. Much of the
substrate exists (swarms, cron, skills, voice, memory, channels; `#204` shipped
`tool_search`, WS1–WS7 tracked in `openclaw-gap-integration.md`). What is absent
is any evaluation that these hold up end-to-end — e.g. "day 10 is measurably
better than day 1" (self-taught codebase navigation) is a claim nobody has
tested.

## Plan

Ordered so that the measurable gaps close first, because without them the loop
the brief asked for cannot start.

### Phase 1 — Make the executor claim true or false (highest value)

Instrument and measure the planner→executor split. Concretely: record planner
tokens vs executor tokens per delegated run, and report the ratio.

The failure the brief names is specific and worth stating as a pass condition:
if the planner's output is so detailed that execution is mechanical
transcription, the split saved nothing — it just moved the work and added a
hop. So:

- **Measure:** `plannerTokens`, `executorTokens`, `executorToolCalls` per run.
- **Pass:** executor does non-trivial work (≥3 tool calls) *and* total paid-API
  tokens drop meaningfully versus the same task run without a plan.
- **Fail loud:** a plan that yields ≤1 executor tool call is the anti-pattern —
  surface it rather than counting it as a success.

An A/B harness over a fixed task set gives the number. Without it, Phase 5
(semantic accept) should not be built — it would optimise an unmeasured path.

### Phase 2 — One baseline, one target, then loop

Define a small scored suite that reflects the actual goal ("output/quality"),
not component health. Suggested axes, each already partly instrumented:

1. **Did it produce the artifact?** (evidence gate — now measurable)
2. **Delivery lag** (`run-health.ts` — already measurable)
3. **Cost per completed task** (needs Phase 1's accounting)
4. **Did it need a human?** (approvals raised per task)

Score a fixed task set once → that is the baseline. Set the target. Loop.
The point is the stopping condition, which today does not exist.

### Phase 3 — Run the three unrun scenarios

Cheapest way to find real defects; the two scenarios that *were* run produced
two genuine, now-fixed bugs. Run trip-planning first — it is the only test of
non-coding competence, and the brief's vision ("perform at claude-code level")
is currently unevidenced outside coding.

### Phase 4 — Close the deferred items

- `TPG_API_KEY` is `scope=user` while the models referencing it are global
  (`Gemini 3.1 Flash Lite`, `claude-sonnet-4-6`). Every other user, and any
  swarm child running as them, resolves no key. **This is the single remaining
  e2e failure (141/142)** and is an owner decision — it is a secret.
- Dependabot #303 open.
- No client renders `agent.blocked` yet; the backend emits it and the protocol
  carries it, but nothing surfaces it visually.
- Planner→executor Phase 5 (semantic accept) — gated on Phase 1 above.
- Legacy `deepseek-chat` / `deepseek-reasoner` entries in the LiteLLM config now
  silently alias to `deepseek-v4-flash` upstream. Unused today; misleading if
  anyone binds a lane to them expecting a reasoning model.

## The honest answer to the brief's own test

> *"Could octipus perform the same task I just gave you, or would it fail or
> output half-done, low-quality stuff?"*

Measured, not guessed: on 2026-08-01 it was given a smaller version of this task
and **reported a full green 7-stage development cycle over an empty workspace**.
That specific failure is now fixed — a declared stage that writes nothing fails,
and CLI-backed stages carry the counters that make the gate bite on the default
`agents` lane.

But the general answer is still no, and the reason is the gap above: octipus can
now be *caught* producing nothing, which is a real improvement over silently
claiming success. It cannot yet be shown to produce *good* work, because nothing
scores quality. Phase 2 is what changes that.
