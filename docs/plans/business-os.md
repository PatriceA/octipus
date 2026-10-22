# Business OS on Octipus: core, connectors, and what we don't build

Date: 2026-10-22
Status: plan. Phase 1 is in progress, one PR per point, each with a code review.

The target is a business operating system for an ambulant care company
("kupfer&klee OS"): 20 modules on one shared core (Vorgänge, Personen,
Dokumente, Rechte, Wiedervorlagen), a hybrid AI setup with a privacy gateway,
and agents that propose while people decide. This plan records where Octipus
stands against that target, how the work is split between the core and plugins,
and the order of work.

## Guiding rule for the split

- **Core:** what every module needs, and everything a security promise depends
  on (privacy gateway, rights, audit, approvals). Third-party code cannot be
  trusted to keep those promises, so they cannot live in a plugin.
- **Plugin / connector:** anything specific to one vendor (DATEV, finAPI,
  Meta, euregon snap, Komda, fonio.ai). Plugins ship outside the main repo and
  are installed from a marketplace.
- **n8n:** the long tail of SaaS integrations, exposed to Octipus as MCP tools.
- **Don't build:** certification work, regulated payment execution, and
  writing into the systems of record.

## Where Octipus stands (audit of 2026-10-22)

Checked in code, not in the docs.

### Already a head start

- Agent runtime, roles, pipelines with approval gates, task board with due
  dates and dependencies, recurring tasks, monitors, heartbeat.
- Login with TOTP and passkeys, SAML SSO, SCIM; spaces with roles and guests;
  agents held to the same space scope.
- `audit_log` for every tool call and state-changing API call; action recovery
  for uncertain outcomes; stopping an agent's session.
- Approval policy (ask/deny/blocked), durable `agent_approvals`, approvals
  forwarded to chat for background runs.
- Spend budgets per day or month, per user, role, workspace or space.
- Local models (Ollama, LM Studio, llama.cpp, vLLM) with a hardware-fit check.
- Read-only SQL against Postgres (`sql_query` in a read-only transaction).
- Documents with OCR through a vision model, categories, embeddings; RAG,
  knowledge graph, notes.
- Gmail and Microsoft 365 mail (inbox watch, triage, drafts), calendar,
  contacts; Slack, Teams, Telegram, WhatsApp; telephony via Twilio, Telnyx,
  Plivo.
- MCP client (stdio, SSE, streamable HTTP), inbound webhooks, hooks, a plugin
  loader with a versioned SDK.

### Gaps

| Area | Gap |
|---|---|
| Domain model | No Vorgang (case) entity linking people, documents and tasks. No follow-ups that fire on a date (task wakeups only fire on dependencies). No forms that save data (artifacts are read-only, inline UI cannot submit). |
| Privacy gateway | No protection level (Schutzstufe 1-4) on data. Sensitivity routing (`gateDecision` in `src/models/decision.ts`) covers only internal decision calls, not chat or agent turns. `pii-filter.ts` masks one way with regexes: no names, IBANs or addresses, no German formats, no way back. |
| Rights | No company > location > team hierarchy. `org_admin` is barely enforced. No approvals by authority or amount, no approval chains, no approvals inbox. |
| Audit and control | Audit log is a plain writable table, writes are best effort, no "why / which source" field. No lasting per-agent kill switch, no global emergency stop. |
| Mail | Gmail and M365 only. No IMAP/SMTP/POP3, so German mail hosts, on-prem Exchange, fax-to-mail and the KIM client module are out of reach. |
| Input | No scan folder ingest. `docs/RAG.md` claims Tesseract OCR, which does not exist in `src/`. The eval harness only runs built-in datasets, not your own documents. |
| Models | No native Bedrock provider. The Vertex provider uses the OpenAI-compatible endpoint, which does not serve Claude. |
| SQL | Read-only SQL is Postgres only; no MSSQL or MySQL driver, no schema reader. |
| Operations | `scripts/backup.ts` vault backup is a stub (prints "backed up", writes nothing). Workspace files are not backed up, nothing is scheduled, no standby. Sandbox (bwrap/firejail/Docker) is off by default and Linux only. No hardening guide. |
| UI language | UI is hardcoded English, no i18n. `UserPreferences.language` is stored but unread. |
| Plugins | Plugins run in the main process with full rights and only add tools (`PluginContext` = logger + config). No screens, triggers, events, data or credential flow. No permissions manifest, no signing, no remote install. |
| n8n | Two paths exist: n8n as an MCP server (documented), and the `n8n_workflow` hook action, which calls `/api/v1/workflows/{id}/execute`. n8n's public API has no such endpoint as far as we know, so the hook path is probably broken. Nothing ships or tests n8n end to end. |
| Modules | None of the 20 modules has a domain implementation. Closest fit: Aufgaben & Meetings, Wissen & Schulung. |

## 1. Built into the core

| # | Area | Contents |
|---|---|---|
| C1 | Shared data model and forms | Vorgang (case), Person/organisation link, Dokument link, Wiedervorlage (follow-up on a date). Generic record types defined by a JSON schema, so plugins can contribute "Rechnung" or "Fahrzeug" records without their own tables. Forms that save into records. |
| C2 | Plugin platform | Package unit = an MCP server plus an Octipus manifest, run as a separate process. Manifest declares allowed network hosts, the highest protection level the plugin may see, which tools have external effect (always need approval), settings as a JSON schema. Credentials through the vault; OAuth through connector definitions. Plugins can report events that the core turns into cases or tasks. |
| C3 | Mail | IMAP/SMTP, plus POP3 for the KIM client module. Functional (shared) mailboxes. |
| C4 | Scan folder | A watched folder; scanner and fax-to-mail drops land in the DMS. |
| C5 | Backup | Real vault backup, workspace files, scheduled runs, restore check. |
| C6 | Privacy gateway | Protection level on documents, cases and records; unclear = 4. Routing on the main path: level 3-4 local only, level 1-2 to Claude in the EU after pseudonymization. Reversible pseudonymization with German names, IBANs, addresses. Every plugin call passes through it. |
| C7 | Eval harness on own documents | Run a folder of real documents with reference answers across candidate local models, score OCR and field extraction. |
| C8 | Rights | Company > location > team > role, for people and agents. |
| C9 | Approvals by authority | Rules by amount and type, approval chains, an approvals inbox page. |
| C10 | Audit and control | Append-only audit log (hash chain), why/source fields, guaranteed writes. Lasting per-agent kill switch, global emergency stop. |
| C11 | Models | Native Bedrock provider (EU region). Claude on Vertex through Anthropic's API on Vertex. |
| C12 | SQL access | Read-only drivers for MSSQL and MySQL next to Postgres, plus a schema reader. Only the access is core; the meaning of the data comes from a plugin. |
| C13 | Operations | Warm standby on the second Mac mini via Postgres replication. Sandbox on by default on macOS. Hardening guide. |
| C14 | UI language | DE/EN/PL translations; reply language from the user preference. |
| C15 | Registry and marketplace | Index repository, signed packages, install/update/disable in the UI, compatibility check against `apiVersion`. |
| C16 | Doc fixes | Remove the Tesseract claim in `docs/RAG.md`; fix or remove the `n8n_workflow` hook action. |

## 2. Connector / plugin (outside the main repo)

| System | Route | Note |
|---|---|---|
| euregon snap, Komda | Own plugin per system, on the core SQL access (C12) | Shape of the data is unknown. First a discovery step: get read-only access, read the schema, then map to case, person, appointment. Check whether the vendor contracts allow replica access; otherwise use export files. |
| Generic DB transfer | Plugin "SQL source → record type" with configurable mapping | Works for well-structured sources. Does not replace the snap/Komda mapping work. |
| Banks | finAPI (or a similar account-information service) | Reading balances and transactions (13-week cash forecast, payment matching) is feasible. Paying: generate a SEPA file (pain.001) or a payment proposal; the TAN stays with a person in the bank. |
| DATEV | Staged | Stage 1 without the API: receipts to the DATEV upload mail address (SMTP), BWA and cost reports as export files. Stage 2: DATEV APIs, needs a DATEV Marketplace partnership. Only once stage 1 shows what is missing. |
| KIM | Connector on the core POP3/SMTP, through the existing KIM client module | Only if TI connection and a KIM address exist. Always protection level 4: local model only, every send needs approval. |
| Fax | Fax-to-mail provider, then IMAP | No own fax line. |
| fonio.ai | Webhook/API connector: call summary → case | Phone calls via Twilio/Telnyx/Plivo already exist. |
| Meta, Instagram, TikTok, Google Business/Ads, Search Console | n8n | Exposed as MCP tools, protection level 1 only, posting only after approval. |
| WordPress | Small plugin (REST API) or n8n | |
| Maps / traffic (Touren) | Plugin (Google Maps or HERE) | "Live" only if snap provides positions. |
| Long tail (catering, fleet leasing, licence portals) | n8n or plain email | No own plugins unless a recurring need appears. |

n8n as connector runtime: self-hosted on the Mac mini. Every n8n tool exposed
over MCP gets a protection level and an external-effect flag in the core so it
cannot bypass the gateway. Licence: the Sustainable Use License allows internal
use, not offering it hosted to others. Before relying on it: start it in a test
setup, connect over MCP end to end.

## 3. Don't build

- Writing into nursing documentation, snap or Komda. The OS stays read-only
  towards them.
- Running payments or handling TANs. That needs a payment licence. We prepare,
  people approve at the bank.
- Own TI/KIM implementation, own fax line (certification and hardware).
- Replacing accounting or payroll. The OS prepares and hands over; bookings and
  payroll runs stay in DATEV and with the payroll office.
- Live GPS tracking of staff unless snap already provides it (works council and
  data-protection assessment needed).
- Active-active mirroring of the two Mac minis. Warm standby with tested
  failover is enough.
- Own ad buying or marketing automation. Drafts plus approval, published
  through n8n.

## 4. Order of work

Each point is its own PR with its own code review.

| Phase | Points | Why this order |
|---|---|---|
| 1 Platform | C1 data model and forms · C2 plugin platform · C3 mail · C4 scan folder · C5 backup | Foundation; without it plugins have nowhere to write. |
| 2 Privacy | C6 privacy gateway · C7 eval harness | Before any real personal data goes to Claude. |
| 3 Rights | C8 rights hierarchy · C9 approvals by authority · C10 audit and control | Unblocks invoices, purchasing, contracts. |
| 4 First plugins | n8n check (C16) · finAPI read · DATEV stage 1 · snap discovery | Needs answers to the open questions. |
| 5 Marketplace | C15 registry, signing, marketplace UI · C11–C14 | Needed once plugins come from someone else. |

### Progress

| Point | Branch | PR | Status |
|---|---|---|---|
| Plan (this file) | `ccr-ab69ee55-j1tal5` | #429 | open |
| C1a cases, contacts, links, follow-ups | `feat/cases-contacts` | #430 | in review |
| C1b record types, records, public forms | `feat/record-types` (on C1a) | #431 | in review |
| C1c web pages for cases, contacts, records, forms | `feat/business-web` (on C1b) | #434 | in review |
| Audit fix (ip-address in mcp-server, not part of the plan) | `fix/mcp-server-ip-address` | #433 | in review |
| C2 plugin packages (out-of-repo MCP servers, fenced in) | `feat/plugin-packages` (on C1c) | #435 | in review |
| C3 mail (IMAP/SMTP/POP3, functional mailboxes) | | | next |

## 5. Open questions (answers expected from the business side)

1. **DATEV:** what does the tax advisor need: receipt images, booking batches,
   or only the BWA coming back?
2. **Banks:** how many banks and accounts, and is reading balances and
   transactions enough?
3. **snap / Komda:** which database type do they run on, and does the contract
   allow a read-only copy?
4. **KIM:** is a KIM address with a client module already set up?
