# Workstation authority and unattended project work

The owner needs installed workstation CLIs, their normal account logins and SSH
access to multiple machines to work together without per-program registration or
per-command pipeline approvals. Runtime choice alone is insufficient while
verification, connection repository roots and old tool policies disagree.

1. Add an explicit account-authority grant and a workstation automation preset.
   Existing environments retain tool-policy authority until their owner opts in.
   One account grant covers installed commands, configured SSH access and new
   command forms; deliberate permission denials and shared/private-data boundaries
   remain effective. Provide the same policy for ordinary tools and verification.
2. Use the account filesystem grant for connection Git repositories, preserving connection destination, credential and ownership checks.
   Never interpret remote paths as local repositories.
3. Show effective access and an advisory inventory of commands in the actual
   runtime. Discovery is not an executable allowlist. Explain multi-machine work
   through workstation SSH; do not require one environment per deployment host.
4. Bring routine pipeline gates and recovery under the saved autonomy grant while
   preserving explicit owner pauses and inspecting uncertain prior outcomes.
5. Test shipping shell, verification, native CLI authorization, credential Git,
   settings and revocation paths; independently review before publication.

No installed CLI, remote service or phone is claimed authenticated solely because
its environment policy permits it. No existing user grant is widened implicitly.

Implementation is complete: owner-visible preset and installed-command inventory,
consistent command/file/native CLI identity, connection Git account paths, real
Compose lifecycle access and revocable automatic pipeline consent. Existing
profiles retain restricted defaults; selecting/upgrading a profile is explicit.

Validation includes the full browser suite (365 passed), real shell middleware
through embedded permission storage (26 passed), native CLI subprocess fixtures,
remote transport programs and pipeline gate revocation. Independent backend and
UI reviews found issues that were corrected and rechecked. These fixtures do not
claim actual homelab credentials, deployments or phone acceptance.
