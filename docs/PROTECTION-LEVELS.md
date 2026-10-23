# Protection levels

Every piece of business content carries a protection level: how sensitive it
is, which decides where it may be processed. This is point C6 of the
[business OS plan](plans/business-os.md), the privacy gateway. It is built in
four steps. This page describes the first two (C6a, the levels; C6b, routing
by level) and the design of the rest.

## The levels

| Level | Name | Meaning | Examples |
|---|---|---|---|
| 1 | Public | May be published. | Price lists, opening hours, the website text |
| 2 | Internal | For the business, not personal. | Procedures, supplier terms, internal notes |
| 3 | Confidential | Personal data. | Customer and patient master data, invoices, ordinary correspondence |
| 4 | Strictly confidential | Special categories and anything that would harm someone if leaked. | Health data, KIM messages, HR files, legal matters, bank data |

**Unclear counts as 4.** Content nobody has classified is treated as the most
sensitive, never the least.

## Where levels live (C6a)

| Content | Level | Starts at |
|---|---|---|
| Documents | `documents.protection_level` | The upload's level, the scan folder's or the mail account's default, else unclear |
| Cases | `cases.protection_level` | The level given at creation, else unclear |
| Records | `records.protection_level` | The level given (null: unclear), else its record type's `defaultProtectionLevel`, copied when the record is created |
| Mail messages | `mail_messages.protection_level` | Its account's `defaultProtectionLevel`, else unclear. A reply draft quotes the original: it starts at the higher of the two |
| Filed attachments | the document's level | Their message's level at filing time |
| Cases opened by a form | the case's level | The level of the record the submission created |

A stored level is the content's own: a default is copied when content is
created, and changing a source's default later does not reach content made
before. Null always means unclear, which counts as 4.

Defaults are set on the source: record types, mail accounts (the KIM mailbox
at 4, info@ at 3), and scan folders (the fax drop at 4).

### Who changes a level

- **A person** may set any level, or clear it back to unclear:
  `PUT /api/protection/:kind/:id { "level": 1-4 | null }`, where kind is
  `document`, `case`, `record` or `mail`. This goes through the caller's
  content scope (in a space: editors). Cases and records also take
  `protectionLevel` at creation, and an upload takes `protectionLevel` as a
  form field.
- **An agent** may only **raise** a level (tool `raise_protection_level`):
  it found health data in a document, or a salary in a record. It can never
  lower one, and never clear one to unclear: lowering decides that data may
  go further, and that is a person's decision. The condition is part of the
  write itself, so an agent's raise that races a person's change never ends
  lower than the person set it.
- Levels are set through the scope alone: an admin's by-id access to another
  user's personal content does not extend to its level.
- The API route counts its caller as a person. An API token given to an
  external agent counts as a person too, so keep such tokens away from
  `/api/protection`.

Lists and reads show the level: the API's rows, and the cases, records,
documents and mail tools (as the effective level, 1-4).

## Routing (C6b)

A session carries the highest level of anything it has read, and that level
never goes down within the session. While the `protection` module is on:

- **Level 3-4:** the session's model calls go to local models only.
- **Level 1-2:** the bound model, which may be Claude in the EU.

A model counts as local when its data policy says `hosting: local`, as
`src/models/decision.ts` decides for decision models: Ollama on a private
endpoint (and not one of Ollama's cloud models), or a row with an explicit
local `dataPolicy`. A CLI agent runs on its vendor's servers and never counts
as local, and neither does a fallback to the LiteLLM proxy.

### What raises the level

| Source | Level |
|---|---|
| The documents, cases, mail and records tools | each item's effective level (lists included: titles are content) |
| `search_documents`, `search_knowledge`, `read_knowledge` | the levels of the documents the hits come from; a document deleted since it was indexed counts as unclear |
| Recall (passages handed to the agent as it starts) | the same, before the model is chosen |
| A file attached in the chat | unclear, so 4 |
| `raise_protection_level` | the new level |

Notes, tasks and contacts carry no level yet and raise nothing. The level is
recorded whether or not the module is on, so switching it on later applies
to what a session already read. It is kept in `sessions.protection_level`.

### What happens at 3-4

- **Choosing the model.** The root agent and every child are switched to a
  local model when the bound one is not: the default model first if it is
  local, else the first local model that can call tools.
- **Mid-turn.** A tool result that raises the level switches the agent to a
  local model before its next call, compaction included.
- **No local model.** The turn stops and says so, rather than sending the
  data out: "This conversation holds strictly confidential content
  (protection level 4), which stays on local models, and no local model is
  bound."
- **CLI agents** are not started for such a session. One already running when
  the level rises gets its further tool results withheld.
- **The turn's helpers** (session compaction, memory extraction) follow the
  session too: compaction runs on a local model, and memory extraction on a
  remote model is refused.
- **Every model call** is checked once more before it leaves: completions and
  streams, embeddings, image descriptions, OCR and decision models. An
  embedding model cannot be swapped for another (its vectors would not match
  the index), so a remote one is refused: bind a local embedding model.
- **Images** attached in the chat are described by a local model that reads
  images, or not described at all, and the agent is told why.

### The document pipeline

OCR, category, summary and indexing follow the document's own level the same
way: a document at 3-4 (an unclassified one included) is read by local
models. A remote native-OCR endpoint is skipped for the vision path, and the
default model is replaced by a local one for the category and the summary.
When a step finds no local model, the document is marked failed with the
reason. Bind the `ocr`, `vision` and `embedding` topics to local models.

## What the levels will decide (C6c-C6d, not built yet)

**C6c. Pseudonymization.** For level 2 (and level 3, where the owner allows
it) on the way to a remote model:
- Names, addresses, IBANs, phone numbers, e-mail addresses, dates of birth and
  identifiers (customer, patient and insurance numbers) are replaced by stable
  placeholders (`[PERSON_1]`, `[IBAN_1]`).
- Each session keeps its own mapping, so the answer is translated back before
  anyone sees it.
- The detector covers German names and formats (German first and last names,
  street and postcode patterns, DE IBANs) and is tested against real-shaped
  samples (plan point C7).

**C6d. Plugin calls.** Every plugin package declares the highest level it may
see (`maxProtection`, see [PLUGIN-PACKAGES.md](PLUGIN-PACKAGES.md)).
- A tool call carrying content above that level is refused.
- A call to an external system counts as leaving the house, just like a remote
  model.

## Not yet

- The steps C6c-C6d above.
- Memories and notes carry no level: a fact remembered from a level 4
  conversation (extracted by a local model) can surface in a later
  conversation without raising it. Reading a document's file through the
  filesystem tools raises nothing either.
- Several server processes share a session's level through the database at
  the start of each turn; a raise in one process reaches another at its next
  turn, not mid-turn.
- Levels on notes, tasks and contacts (contacts hold personal data and will
  likely start at 3).
- A web control to set levels (the API is there).
