# Capability review

The former comparison used an unidentified “competitor” and an unverifiable
placeholder URL. Its feature rankings and superiority claims have been removed;
they are not a sound basis for choosing a product.

For Octipus's current capabilities and limitations, use:

| Area | Current reference | What still needs evaluation |
|---|---|---|
| Agent execution | [Agent architecture](AGENT-ARCHITECTURE.md) | Task correctness, suitable delegation, and provider-specific tool reliability |
| Tool permissions | [Tools API](API.md#tools) | Coverage of each integration and external execution boundary |
| Swarm evidence | [Swarm reliability](SWARM-RELIABILITY.md) | Independent acceptance criteria; receipts do not certify correctness |
| Knowledge and documents | [RAG](RAG.md), [Documents](DOCUMENTS.md) | Retrieval quality and extraction accuracy on your corpus |
| Channels and voice | [Channels](CHANNELS.md), [Voice](VOICE.md) | Live credentials, provider behavior, and client-specific interaction limits |
| Deployment | [Configuration](CONFIGURATION.md), [Docker](DOCKER.md) | Deployment-specific isolation, recovery, and resource requirements |
| Validation | [Testing](TESTING.md) | Live-provider quality remains separate from fixture-based CI |

A useful future comparison should pin both projects' revisions, use the same
workloads, record measured outcomes and cost, and distinguish implemented code
from independently verified behavior. No such comparative benchmark is claimed
here. The [OpenClaw record](OPENCLAW-COMPARISON.md) is a historical inventory,
not a current ranking.
