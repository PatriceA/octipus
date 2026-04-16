# Assistant Design Principles

> **Note.** This document was drafted fast to ship the public release. If you have the time and taste to rewrite it more cleanly, a PR that improves the writing is as welcome as one that fixes a bug.

A reference for contributors. These are the opinions that guide every decision. If a feature fights one of these, it does not ship in its current shape. Arguments welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) — but the burden of proof is on the change, not the principle.

---

## Coordination, not replacement

Assistant coordinates things, it does not replace them. LLMs, databases, APIs, humans, tools, channels — these are **primitives**, not libraries you bolt on. The orchestrator's job is to wire them together correctly and cheaply.

The surface area of the core is small on purpose. You learn the orchestrator, roles, pipelines, and the permission model once. Everything else is nodes composed of those.

## If it routes, the contract is sound

Same philosophy as a type checker, but for agent handoffs. Before a worker starts:

- **Classification happens deterministically.** Keyword heuristics first, LLM only when ambiguous. The classifier is a cheap, explainable filter — the orchestrator is the expensive reasoner, not a routing lookup.
- **Role contracts are typed.** Every role has a documented input shape, tool allowlist, and deliverable format. A worker cannot be spawned without a resolved role config.
- **Pipelines are sequences of typed stages.** Stage N's output is stage N+1's input. Handoff context is a structured document, not a freeform blob.

The only failures after routing are external: a tool returns an error, an API times out, a human never responds. The *contract* is not in question at that point — the world is.

## One job per role

If a role is branching on config flags to do five unrelated things, it is five roles. The classifier + router exists precisely so you can be specific. A bloated role is a routing failure disguised as flexibility.

Corollary: **tool allowlists are minimal**. A role gets only the tools it actually needs. No wildcards. A security worker does not need shell write. A writer does not need `git push`. Principle of least privilege applies to agents too.

## No special cases

When a capability is needed, the language of the platform gets a general feature and the node uses it. No role ever requires custom orchestrator support.

"Wait for approval" is not approval-specific. It is "pause the pipeline until an external signal arrives" — used by human approval, webhook gates, and scheduled resumes. "Remember a fact about the user" is not a profile-specific feature. It is a generic fact store that profiles happen to use.

Two things fall out:

1. The core stays small.
2. When contributors learn a pattern, it works everywhere. No per-role escape hatches to memorize.

## Channels are adapters, not features

Telegram, Slack, WhatsApp, Teams, WebChat, TUI — all speak the same gateway protocol. A feature added to one channel that cannot be expressed through the gateway is wrong. Fix the gateway.

A corollary: **sessions are channel-agnostic at the orchestrator level**. The orchestrator sees `sessionId`, not `telegram_chat_id`. Channels resolve sessions on the way in and translate events on the way out.

## Fail loud

No silent fallbacks. Nodes either work or fail with a clear error. Every failure surfaces to the user unless explicitly swallowed with a logged reason.

- If a tool returns an error, the worker sees the error — not a fabricated successful-looking reply.
- If a model provider is down, the failover engages or the request fails with a named reason. Never a silent "generic assistant" stub.
- If an input is malformed, it is rejected at the boundary with a specific message. Never coerced into something pretend-valid.

## Security preamble is load-bearing

Every worker and the orchestrator get the `SECURITY_PREAMBLE` at the start of their system prompt. It is not a nice-to-have. The input guard (39 regex patterns) and output guard (LLM-based) layer on top but do not replace it. Do not edit the preamble without an issue and an argument.

## Durable where it matters, ephemeral where it helps

- **Messages, sessions, agents, audit trail, vault** → durable. DB-backed. Survive restart. Auditable.
- **Worker event streams, typing indicators, gateway pub/sub** → ephemeral. In-memory. Replayable from buffer (200 events per session) but not persisted past process lifetime.

Confusing the two is where bugs grow. If a user needs to see an event after a crash, it lives in the DB. If the only consumer is a live WS, the event bus is enough.

## Two views of the same thing

A pipeline, a role configuration, a skill — each has a **code form** (JSON, markdown, TS) and a **visual form** (DAG graph, config form, rendered prompt). Editing one updates the other. Neither is canonical; both are projections.

This mirrors the [Weft](https://github.com/WeaveMindAI/weft) graph↔code duality. Applied to assistant:

- Pipelines render as stage DAGs in the web UI, editable in either view.
- Roles render as config forms *and* as the raw markdown prompt. Power users prefer raw; newcomers prefer forms. Both work.
- Skills are markdown files with typed frontmatter — the form view reads frontmatter, the prompt view reads the body.

## Recursive composability

Pipelines are nodes. A pipeline stage can itself be a pipeline. A team of workers can be wrapped as a role. Skills can be composed.

A 100-stage system still looks like 5 blocks at the top level because each block hides a pipeline that hides a pipeline. No hidden coupling, no global scope — only inputs, outputs, and handoff context cross a boundary.

## Observability over cleverness

If the system does something surprising, the user should be able to find out why without reading the source. Source attribution (recent messages, profile facts, knowledge base hits) is appended to replies by default. Event logs are exposed in the web UI. The agents overview lists every agent that ran, not just live ones.

Clever routing that is hard to inspect is worse than obvious routing that is slow.

## Local first, cloud second

Assistant should be fully usable with:

- Local models via Ollama
- Embedded PostgreSQL (PGlite) instead of a real DB
- In-memory cache instead of Redis
- No external API keys at all

Cloud providers are upgrades, not requirements. A new feature that only works with a specific cloud provider is suspicious.

## Evaluation is part of the build

Every non-trivial change to routing, roles, prompts, or tool selection goes through the eval harness (`bun run eval`). Red-team tests (prompt injection, role confusion, tool misuse, data leakage, off-topic drift) are part of CI. A regression in the eval suite blocks merge.

## Small core, large catalog

The core (orchestrator, gateway, permission system, vault, DB schema) should stay small and rarely change. The catalog (roles, skills, tools, channels, experts, pipeline templates) grows freely. When in doubt, push complexity to the catalog, not the core.

---

## Argue with these

Some of these will age badly. If you have a real argument — not "this is annoying", but "this prevents X and costs Y" — open an issue. Principles get updated when the reasoning for them no longer holds. But the default is to preserve them: many have been paid for in bugs.
