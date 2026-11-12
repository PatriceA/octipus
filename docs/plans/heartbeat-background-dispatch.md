# Heartbeat background dispatch

The heartbeat checklist currently enters chat orchestration and starts General,
including when its only inputs are routine agent completion notifications.
Undated role-assigned tasks are missed unless a separate role hook is enabled.

1. Make the personal heartbeat a deterministic probe and durable notification
   delivery. Never call chat orchestration or create a check-in session.
2. Filter completion/digest notifications and deduplicate surfaced findings.
   Commit digest and checkpoint together. Preserve unread/handled state.
3. Dispatch ready role-assigned tasks using role workers, even without due dates.
   Explicit role hooks own their roles, including disabled hooks. Reuse the
   parent hook lease and budgets, claim the selected task before model routing,
   refresh its source protection, and retain ordinary unattended permissions.
4. Apply standing instructions only to real task work. Document that inbox watch
   now reports new email rather than asking General to create tasks or drafts.
5. Add regression coverage for silent checks, noise, repeated findings, explicit
   pauses, task races, source protection, leases and role selection. Run checks
   and independent review before activation.

No new model binding, heartbeat chat, or separate user switch is introduced.
