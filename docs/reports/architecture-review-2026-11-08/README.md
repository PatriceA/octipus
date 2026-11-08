# Comparison studies — 2026-11-08

Appendices to the [architecture, session-cache and plugin review](../architecture-cache-plugin-review-2026-11-08.md).
Each study covers one comparison project. It was produced by reading a shallow
clone of that project's default branch. Nothing from it was installed, built or
run. The `file:line` references point into the revision named at the top of
each study, not into Octipus.

| Study | Project | Revision |
|---|---|---|
| [deepseek-harness.md](deepseek-harness.md) | DeepSeek Harness (`deepseek-ai/deepseek-harness`) | `fcc0ad46`, v0.2.2-rc.1 |
| [hermes-agent.md](hermes-agent.md) | Hermes Agent (`NousResearch/hermes-agent`) | `48c7a09f` |
| [odysseus.md](odysseus.md) | Odysseus (`odysseus-dev/odysseus`) | `1c15090`, `dev`, harness 0.20.19 |
| [pi.md](pi.md) | Pi (`earendil-works/pi`) | `e49b149`, v1.5.0 |

Every study follows the same outline: turn flow, modes, providers, prompt and
session caching, prompt construction, context management, tools, plugins,
subagents, performance, ideas worth adopting, and weaknesses. A study marks
claims it could not verify. The DeepSeek Harness study, for example, marks
behaviour delegated to the un-vendored `pi-ai` library.
