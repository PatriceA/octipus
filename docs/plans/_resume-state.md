# Resume state — 2026-05-05 ~18:15 GMT+2

## Completed this session

- **CLI subagent + auto-curated discovery — committed** 7803855
- **Grok (xAI) provider — committed** 0dc3dec
  - Phase 1 backend provider, Phase 2 discovery client, Phase 3 web UI hooks
  - Phase 4 (website docs) — skipped, website source not present in this repo
  - tests: 22 pass; backend + web typecheck clean

## Open / blocked

1. **Website redeploy still blocked** — kernel rebooted (uptime 3 min) but
   `host:8090 → 000`; container nginx serves on `:80` internally. iptables
   DOCKER chain inspection requires sudo. Needs user with root to:
   ```bash
   sudo iptables -t nat -L DOCKER -n
   sudo systemctl restart docker
   ```
   Suspect `iptable_nat`/`xt_DNAT` not registered for the new kernel build,
   or the docker daemon needs a restart after the reboot.

2. **Grok end-to-end** — needs a real `XAI_API_KEY` to verify
   `/api/models/providers/grok/available` returns a curated live list and a
   chat round-trip succeeds. Static checks (typecheck, tier inference,
   no-static-shortlist guard) all green.

3. **Website docs for Grok + CLI providers** — `docs/features/cli-providers.mdx`
   and the model/orchestrator updates referenced in the prior resume state
   were not on disk in this repo. They likely live in a separate website
   project; redo those edits there when surfaced.
