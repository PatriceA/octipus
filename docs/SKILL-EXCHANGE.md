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

Skills can also be **browsed** in [registries](#registries): static JSON
indexes of signed bundles that anyone can host on a web server or a git
host, and that an operator lists in the settings. Octipus ships none and
contacts none until one is listed. Installing from one is the same preview
and install as any import.

Not built: a hosted or default registry, ratings, and automatic updates.

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
  No text may hold a control character other than tab and line breaks (a
  name or category not even those): NUL, escape sequences and the like are
  refused at preview, naming the field.
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
and nothing is written. Collisions are what **you** can see: an
administrator's import no longer matches, or overwrites, another user's
private skill by name (the removed `POST /api/skills/import` did).

Two installs by the same person at once are serialised, and the names to
create are checked again inside the transaction: the second is refused with
`409` ("created since the preview") rather than creating the skills twice.

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
  the content hash, the signature status, publisher and key id. The audit rows
  are written in the same transaction as the skills: if they cannot be
  written, nothing is.

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

A bundle from a [registry](#installing-from-a-registry) follows the "From a
URL" column, with only the keys of the registry's own publishers counting as
trusted.

### From a URL

Administrators only. The download goes through the same SSRF-guarded https
fetch as a plugin package install (no private addresses, redirects checked,
at most 1 MiB, 15 s), and the bundle must carry a valid signature by a
trusted publisher, whatever `requireSignature` says. Other users download the
file and upload it.

## Registries

A skill registry is a static JSON file, the [index](#the-index), that lists
signed bundles and where to download them. There is no service to run:
build the index with `octi plugin build-skill-index`, then publish it and the
bundles unchanged on any https host (a web server, GitHub Pages, a raw file in
a git repository).

### Adding a registry

Administrators list registries in Settings → Skills, `skills.registries`
(admin settings, like every setting):

```json
[{ "name": "acme", "url": "https://skills.acme.example/index.json", "publishers": ["Acme"] }]
```

- **Empty by default.** No registry is listed, and no index is fetched,
  unless an operator adds one. Octipus names no registry of its own.
- **`publishers`** are names in `plugins.trustedPublishers` whose keys count
  for bundles **from this registry**. A bundle signed by any other key, a
  trusted publisher of another registry included, is not installed from it.
  A name stands for every `plugins.trustedPublishers` entry of that name:
  two entries with the same name both count. Revocation and expiry
  (`revoked`, `notAfter`, `plugins.revokedKeys`) apply as everywhere else.
- At most 20 registries, unique names, https only. The URL may carry a
  token in its query: it is shown to administrators in the settings only,
  never in a listing, a preview or an error, and logged without its query
  or user info.

### Browsing

Skills → **Import** → **Browse registries** (`GET
/api/skills/exchange/registry?q=&tag=`), for anyone signed in:

- the newest version of each listing of every registry, with its older
  versions named; a search over every word (name, description, author, tags,
  skill names) and a tag filter;
- the signature status the index **claims**, judged by the operator's keys
  for that registry: signed by one of its publishers, not signed, a key it
  does not trust, expired or revoked. It is checked for real at preview;
- the version (and content hash) you installed from that registry, and
  **an update available** when the index lists a higher version with
  content you have not installed before. That is all it does: nothing is
  ever updated, replaced or reinstalled by a registry.
- A registry that cannot be read is named with the class of failure only
  (timed out, an HTTP status, too large, a private address, a redirect not
  followed, or what is wrong with the document); the others are still
  listed. A listing that breaks the index rules is skipped and reported.

Indexes are cached for 5 minutes (a failure for 30 seconds), at most 32 of
them, and concurrent reads of one index share a request; an answer carries
at most 500 listings. Browsing downloads no bundle.

### Installing from a registry

**Preview** on a listing is the import preview of that listing
(`{ registry: { registry, name, version } }`), and **Install** is the same
install, with the same collisions, decisions, audit and content-hash check.
There is no install without a preview. Anyone signed in may do it (an
administrator chose the registry); the bundle becomes their own skills. An
API token needs `api:write` for a registry (or URL) preview, since it makes
the server download, and each person may start at most 30 registry previews
and installs a minute (`429` beyond). A bundle that matched its digest is
reused by that digest for 10 minutes (at most 16 bundles, 8 MiB).

Preview and install each download the bundle again and refuse it unless all
of this holds:

1. the registry is configured and its index lists that name and version;
2. the bundle URL is https, on a public host: no credentials, no fragment,
   not localhost and no private, loopback, link-local or ambiguous IP literal
   (checked when the index is read), and the download goes through the same
   SSRF-guarded fetch as a URL import (every address resolved and checked,
   redirects https and checked again, at most 1 MiB, 15 s for the whole
   download, redirects included);
3. the downloaded bytes hash to the index's `bundleSha256`;
4. it is a valid bundle (schema, limits, content hash) whose `contentHash`,
   skill names and signing key id are the ones the listing claims;
5. it carries a **valid signature by a key of one of the registry's
   publishers**, whatever `plugins.requireSignature` says, as for a URL
   import. The digest only pins the bytes; it never stands in for the
   signature. An unsigned bundle, or one signed by a key the registry is not
   trusted for, is previewed (so you can read it) and shown as such, and is
   not installable.

The audit rows of an install name the registry, the listing and its version.
Which version and content you installed is recorded per person, registry
(its name and a hash of its URL: a name reused for another index starts
afresh) and listing, with every version and content hash installed before
(`skill_registry_installs`): that is what "update available" and the
preview's warnings compare with. A skill you then replace with another
import no longer counts as installed from the registry. To update, preview
the newer version and choose **Replace** for each skill it collides with.

#### What a signature does not cover

A bundle's signature covers its skills, not the listing's name or version.
So a registry (or whoever controls its index) can:

- relist an old, validly signed bundle under a higher version (a rollback);
- relabel a bundle under another listing name;
- replay a bundle another registry lists, when both trust the same
  publisher.

Octipus cannot tell these from a genuine release. It narrows them: an
"update available" is never shown for the content you installed or content
you installed before; the preview shows what you installed (version and
content hash) next to the listing, and warns when this content was
installed before under another version (a possible rollback) or is other
content under a version that is not higher than yours. Read the content
before you replace a skill with it.

### The index

```json
{
  "format": "octipus-skill-index",
  "version": 1,
  "generatedAt": "2026-11-23T10:00:00.000Z",
  "entries": [{
    "name": "release-notes",
    "version": "1.2.0",
    "description": "Write release notes people read",
    "tags": ["writing"],
    "author": "Acme",
    "publisherKeyId": "ed25519:<64 hex>",
    "skills": ["Release notes"],
    "bundleUrl": "https://skills.acme.example/release-notes-1.2.0.json",
    "bundleSha256": "sha256:<64 hex of the bundle file's bytes>",
    "contentHash": "sha256:<the bundle's contentHash>"
  }]
}
```

- **`name`**: the listing's identifier in the registry, lower-case letters,
  digits, `.`, `_` and `-` (at most 100). **`version`**: SemVer 2.0
  (`1.2.0`, `1.2.0-beta.1`) without build metadata: no leading zeros, no
  empty identifiers, numbers of at most 6 digits (9 in a pre-release), a
  pre-release of at most 64 characters. An index may list every version of a name; the
  same name and version twice are both skipped.
- **`description`** (at most 1,000 characters), **`tags`** (at most 10 of 32)
  and **`author`** (at most 100, or null) are plain, single-line text, shown
  as text: never rendered as HTML or Markdown. No control, bidirectional or
  invisible characters.
- **`publisherKeyId`**, **`skills`** (the bundle's skill names, in order) and
  **`contentHash`** are claims the install checks against the bundle.
  `publisherKeyId` is null for an unsigned bundle.
- **`bundleUrl`**: https, public host (see above). It may be on another host
  than the index.
- **Limits:** the index is at most 1 MiB and 2,000 entries. A larger, or
  newer (`version` above 1), or malformed document is refused as a whole; an
  entry that does not fit is skipped and reported, never installable.
- The index is not signed. Its digests, `contentHash`, `skills` and
  `publisherKeyId` are checked against the bundle, whose own signature
  decides who published the content; `name`, `version`, `description`,
  `tags` and `author` are the registry's word only
  ([What a signature does not cover](#what-a-signature-does-not-cover)).

### Publishing a registry

Put the signed bundles in one folder, each with a `<file>.listing.json`
beside it:

```json
{ "name": "release-notes", "version": "1.2.0", "tags": ["writing"], "author": "Acme" }
```

(`description` is taken from the skill when the bundle holds one skill;
give it for a bundle of several.) Then:

```sh
octi plugin sign-skill-bundle release-notes-1.2.0.json --key acme.key
octi plugin build-skill-index ./skills --base-url https://skills.acme.example/
```

It checks every bundle as an import does and writes `./skills/index.json`
(`--out` to change it), with each digest, content hash, skill list and key id
read from the bundle itself. It warns about unsigned bundles: no Octipus
installs them from a registry. Publish the folder unchanged; a bundle edited
afterwards no longer matches its digest. Operators who trust you add the
index URL and your publisher key. Symbolic links in the folder are never
followed (a linked bundle is skipped, a linked listing file refused), and
`generatedAt` is `SOURCE_DATE_EPOCH` when it is set, for reproducible
builds.

## SKILL.md

Import accepts an agentskills.io `SKILL.md` too, read by the same parser that
mounts skill folders (`src/skills/external-loader.ts`): `name` and
`description` are required in the frontmatter; `category` is read; the body
becomes the skill's content. Other frontmatter (`allowed-tools`, `license`,
`metadata`, …) is left out and named in the preview: an imported skill grants
no tools. A nested frontmatter value (a list or a mapping) is never read, only
named, so YAML anchors cannot blow up its size. A SKILL.md has no signature,
so it imports as unsigned, and `requireSignature` refuses it.

## Older exports

`GET /api/skills/export` and `GET /api/skills/:id/export` still write plain,
unsigned files, and both import:

- **Their JSON** (`{ "skills": [...] }`, or one skill): paste or upload it as
  a bundle. It shows as `legacy_export`, unsigned (so `requireSignature`
  refuses it). Each skill goes through the same strict schema and limits; a
  field the bundle does not carry (an id, an owner, `isSystem`, …, as older
  exports may hold) is dropped and named in the preview, never installed.
- **Their markdown** (`format=markdown`, several skills in one file): paste or
  upload it as a SKILL.md; every skill in it is read.

Collisions, trust settings, the preview and the audit are the same as for a
bundle.

How the two relate: a `SKILL.md` folder is how a skill lives on disk, mounted
read-only with its supporting files. A bundle is how a database skill
travels: several skills in one file, hashed and signable, without supporting
files. To keep a skill's scripts and assets, share its folder and mount it;
to hand someone skill text with a verifiable publisher, send a signed bundle.

## API

| Method | Endpoint | |
|--------|----------|--|
| GET | `/api/skills/exchange/registry?q=&tag=` | `{ registries, listings: [{ registry, name, version, description, tags, author, publisherKeyId, skills, bundleUrl, bundleSha256, contentHash, olderVersions, signature: { status, publisher, detail }, installedVersion, installedContentHash, updateAvailable }], errors: [{ registry, error }], problems, truncated }`. Index URLs are never in it. Nothing is fetched when no registry is configured. `401` signed out. |
| GET | `/api/skills/exchange/export?ids=a,b` | `{ bundle, signed: false, note }`. `401` signed out, `400` a mounted id or more than 50, `404` an id you cannot see. |
| POST | `/api/skills/exchange/preview` | Body: exactly one of `{ bundle }` (the JSON text), `{ skillMd }`, `{ url }` (admins), `{ registry: { registry, name, version } }`. Writes nothing. `{ source, url, registry, contentHash, signature: { status, publisher, keyId, detail }, installable, refusal, warnings, skills: [{ skill, collision: { id, name, kind, canReplace } \| null }] }`. `registry` is `{ registry, name, version, installed: { version, contentHash } \| null }` for a registry listing. `400` a malformed or tampered source, `403` a URL from a non-admin, or a URL or registry source with a token lacking `api:write`, `404` a version the registry does not list, `429` more than 30 registry previews and installs a minute. |
| POST | `/api/skills/exchange/install` | The same source, plus `contentHash` (from the preview) and `decisions: [{ name, action: "create" \| "skip" \| "rename" (newName) \| "replace" (skillId) }]`. `{ created, replaced, skipped, contentHash, signature }`. `400` refused by the trust settings or a bad decision, `403` replacing what you may not (or a token without `api:write`), `409` a collision without a decision, a taken new name, or a source that changed since the preview. |

These replace `POST /api/skills/import`, which wrote unsigned skills with no
preview, no trust check and no audit. Its inputs still import: the JSON
`skills` array as `{ bundle: JSON.stringify({ skills }) }`, its markdown as
`{ skillMd }` ([Older exports](#older-exports)).
