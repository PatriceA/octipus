# Protection levels

Every piece of business content carries a protection level: how sensitive it
is, which decides where it may be processed. This is point C6 of the
[business OS plan](plans/business-os.md), the privacy gateway. It is built in
four steps. This page describes the first (C6a, the levels) and the design of
the rest, so the whole can be reviewed before it is enforced.

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
| Records | `records.protection_level` | The level given, else its record type's `defaultProtectionLevel`, else unclear |
| Mail messages | `mail_messages.protection_level` | Its account's `defaultProtectionLevel`, else unclear |

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
  go further, and that is a person's decision.

Lists and reads show the level: the API's rows, and the cases, records,
documents and mail tools (as the effective level, 1-4).

## What the levels will decide (C6b-C6d, not built yet)

**C6b. Routing on the main path.** A session carries the highest level of
anything it has read (a tool result, an attached document, a linked case).
- **Level 3-4:** the model calls of that session go to local models only (a
  model whose data policy is `hosting: local`, as `src/models/decision.ts`
  already decides for decision models). With no local model bound, the turn
  stops and says so, rather than sending the data out.
- **Level 1-2:** the bound model, which may be Claude in the EU.

The document pipeline (OCR, category, summary) follows the document's level
the same way. A session's level never goes down within the session.

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

- The steps C6b-C6d above.
- Levels on notes, tasks and contacts (contacts hold personal data and will
  likely start at 3).
- A web control to set levels (the API is there).
