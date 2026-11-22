# Exchanging skills

Skills can leave one Octipus and arrive on another as one versioned JSON
file, a **skill bundle**, with a content hash and an optional Ed25519
signature by a plugin publisher key. On the Skills page, **Export** downloads
a bundle of the skills you choose, and **Import** reads a bundle (or an
agentskills.io `SKILL.md`), shows you everything in it, and writes nothing
until you press **Install**.

An imported skill is prompt text that steers your agents. A valid signature
says who published that exact text; it does not say the text is safe. Read it
before you install it.

Not built: a hosted registry, browsing or searching community skills,
ratings, and automatic updates. There is no community skill index to
discover from, and Octipus ships none.

## The bundle

```json
{
  "format": "octipus-skill-bundle",
  "version": 1,
  "skills": [{
    "name": "Release notes",
    "category": "writing",
    "description": "Write release notes people read",
    "content": "# Release notes\n\nLead with what changed for the reader.",
    "principles": ["Say what changed"],
    "bestPractices": [],
    "antiPatterns": [],
    "frameworks": []
  }],
  "contentHash": "sha256:<64 hex>",
  "signature": null
}
```

- **What it carries:** each skill's name, category, description, body and its
  four lists. Every field is present. That is exactly what creating a skill on
  the Skills page takes.
- **What it never carries:** ids, owners, organizations, `isSystem`,
  `alwaysInject`, discovery triggers, tool grants, usage counters, archive
  state, embeddings or timestamps. A bundle that names any of these is refused
  outright (the schema is strict), so it cannot make itself a system skill,
  give itself to someone, or force itself into every prompt.
- **`contentHash`:** `sha256` of the canonical JSON of `format`, `version` and
  `skills` (each skill's fields in the order above). An import recomputes it
  and refuses a bundle whose skills no longer match it.
- **`signature`:** `null`, or `{ "alg": "ed25519", "keyId": "ed25519:<hex>",
  "signature": "<base64>" }` over the content hash, made with a plugin
  publisher key under its own domain prefix (`octipus-skill-bundle-signature/v1`),
  so a plugin package signature can never pass for a bundle signature or back.
- **Limits:** at most 1 MiB, 50 skills, unique names (case-insensitive); a
  name of at most 200 characters on one line, a description of at most 2,000,
  a body of at most 256 KiB, and at most 100 items of 2,000 characters per list.
- **Versions:** an Octipus reads version 1 and refuses a newer version with a
  message to upgrade.

## Exporting

Skills → **Export**, tick the skills, **Download**. Or
`GET /api/skills/exchange/export?ids=<id>,<id>`.

- You export what you can see: system skills, your own and your
  organizations' (an administrator: any skill).
- Mounted skills are not exported. Their folder can hold scripts and other
  files a bundle has no room for; copy the folder instead.
- **A server export is unsigned**, and says so. An Octipus holds no publisher
  signing key: publisher keys stay offline, as for plugin packages.

### Signing

Sign the downloaded file on the machine that holds your publisher key, with
the key `octi plugin keygen` made:

```sh
octi plugin sign-skill-bundle skills.json --key acme.key [--passphrase-file <path|->]
```

It checks the file as an import would (schema, content hash) and rewrites it
with the signature. Change nothing afterwards: any change to the skills
breaks the hash.

## Importing

Skills → **Import**: upload a file, paste it, or (administrators) give an
https URL. **Preview** shows, without writing anything:

- every skill in full: name, category, description, body and lists;
- the signature: who signed it, the key id, or why it does not count;
- whether the trust settings refuse it, and why;
- each skill whose name is already taken, by whom (yours, a system skill, an
  organization's, a mounted one), and whether you may replace it.

**Install** writes what you chose, in one transaction, after reading and
checking the source again. It requires the content hash the preview showed,
so what is installed is what you reviewed.

### Name collisions

A skill whose name you can already see (case-insensitive) is never
overwritten silently. For each one, choose:

- **Don't import it** (skip);
- **Import under another name** (rename) — the new name must be free too;
- **Replace** it, keeping its id, owner, topic assignments and selections.
  Only its owner or an administrator replaces a skill; a mounted SKILL.md is
  read-only and cannot be replaced.

An install that leaves a collision without a choice is refused with `409`,
and nothing is written.

### What gets written

- A new skill is **your own personal skill**: never a system skill, never an
  organization's (share it afterwards, as any skill). Imported in person on
  the web, it carries the owner-edit lock, like a skill you create by hand
  ([Session learning](SESSION-LEARNING.md#the-owner-edit-lock)).
- It has no embedding yet: the embedding backfill picks it up exactly as it
  does a skill made on the Skills page. A replaced skill's embedding is
  cleared when its name or description changes.
- Every skill written is audited: `settings_changed` on resource `skill`, with
  `op` `skill_imported` or `skill_replaced_by_import`, the source (and URL),
  the content hash, the signature status, publisher and key id.

### Trust settings

Imports follow the plugin package trust settings
([Signed packages](PLUGIN-PACKAGES.md#signed-packages)):
`plugins.trustedPublishers` (with each entry's `revoked` and `notAfter`),
`plugins.revokedKeys` and `plugins.requireSignature`, read at each import.

| Signature | Default | `requireSignature: true` | From a URL |
|-----------|---------|--------------------------|------------|
| Valid, by a trusted publisher | imported | imported | imported |
| None | imported as unsigned | refused | refused |
| By a key not in `trustedPublishers` | imported as unsigned, with a warning | refused | refused |
| By an expired key | imported as unsigned, with a warning | refused | refused |
| By a revoked key | refused | refused | refused |
| Invalid (does not verify) | refused | refused | refused |

A bundle whose content no longer matches its hash, or that fails the schema,
is refused before its signature is looked at.

### From a URL

Administrators only. The download goes through the same SSRF-guarded https
fetch as a plugin package install (no private addresses, redirects checked,
at most 1 MiB, 15 s), and the bundle must carry a valid signature by a
trusted publisher, whatever `requireSignature` says. Other users download the
file and upload it.

## SKILL.md

Import accepts an agentskills.io `SKILL.md` too, read by the same parser that
mounts skill folders (`src/skills/external-loader.ts`): `name` and
`description` are required in the frontmatter; `category` is read; the body
becomes the skill's content. Other frontmatter (`allowed-tools`, `license`,
`metadata`, …) is left out and named in the preview: an imported skill grants
no tools. A SKILL.md has no signature, so it imports as unsigned, and
`requireSignature` refuses it.

How the two relate: a `SKILL.md` folder is how a skill lives on disk, mounted
read-only with its supporting files. A bundle is how a database skill
travels: several skills in one file, hashed and signable, without supporting
files. To keep a skill's scripts and assets, share its folder and mount it;
to hand someone skill text with a verifiable publisher, send a signed bundle.

## API

| Method | Endpoint | |
|--------|----------|--|
| GET | `/api/skills/exchange/export?ids=a,b` | `{ bundle, signed: false, note }`. `401` signed out, `400` a mounted id or more than 50, `404` an id you cannot see. |
| POST | `/api/skills/exchange/preview` | Body: exactly one of `{ bundle }` (the JSON text), `{ skillMd }`, `{ url }` (admins). Writes nothing. `{ source, url, contentHash, signature: { status, publisher, keyId, detail }, installable, refusal, warnings, skills: [{ skill, collision: { id, name, kind, canReplace } \| null }] }`. `400` a malformed or tampered source, `403` a URL from a non-admin. |
| POST | `/api/skills/exchange/install` | The same source, plus `contentHash` (from the preview) and `decisions: [{ name, action: "create" \| "skip" \| "rename" (newName) \| "replace" (skillId) }]`. `{ created, replaced, skipped, contentHash, signature }`. `400` refused by the trust settings or a bad decision, `403` replacing what you may not (or a token without `api:write`), `409` a collision without a decision, a taken new name, or a source that changed since the preview. |

These replace `POST /api/skills/import`, which wrote unsigned skills with no
preview, no trust check and no audit.
