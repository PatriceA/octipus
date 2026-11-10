# Plugin marketplace

Status: proposed (2026-11-10). Marketplace repository:
[PatriceA/octipus-plugins](https://github.com/PatriceA/octipus-plugins) (empty).

## Why

After [plugins for everything](plugins-everything.md), new capabilities are
meant to be plugins rather than core code. Octipus ships two plugins in the
repository, the examples `plugins/reader` and `plugins/research`; nothing else
ships with it, and local plugins never land in the repository. What is missing
is a place where plugins live, get reviewed and published, and where an admin
finds, installs and updates them without copying directories or tarball URLs
around.

## What already exists (host side)

Most of the hard part is built and is not redone here:

- **Install a tarball by URL** (`POST /api/plugin-packages { url, sha256 }`).
  The download goes through the SSRF guard, is checked against the sha256
  before unpacking, and is unpacked by a strict tar reader. It is installed
  through the staged copy, and it **must carry a valid signature by a trusted
  publisher**.
- **Signed packages:** Ed25519 over the content hash
  (`octi plugin keygen`, `octi plugin sign`). Revocation and expiry are set in
  config (`trustedPublishers[].revoked`, `revokedKeys`, `notAfter`).
- **Registries:** an https JSON index of `{ name, version, description, url,
  sha256 }`, listed in `plugins.registries`.
  - The index can be **signed** (`octi plugin sign-index`, `<url>.sig`). A
    registry naming a `publisher` is listed only when that signature verifies.
  - An entry can install only the name and version it lists.
- **Admin → Plugin packages → Browse** lists the registries' packages, with
  Install and Upgrade buttons.
- **Install always lands disabled.** Enabling needs the admin's approvals:
  content hash, host scopes, contributions, in-process, and `model:cli-tools`.
  Every upgrade clears them.
- **`apiVersion`** in the manifest: the host refuses a package written for a
  newer or incompatible plugin API.

A marketplace is therefore mostly: a well-run registry, richer index metadata,
a better Browse page, updates, and online revocation.

## The shape

### The repository: `octipus-plugins`

```
octipus-plugins/
  plugins/<name>/            one plugin package each (octipus-plugin.json, server, ui/, tests)
    README.md                what it does, setup, the secrets it needs
    CHANGELOG.md
    marketplace.json         listing metadata (below); not part of the package
  keys/octipus.pub           the marketplace publisher key (public half only)
  revoked.json               revoked package versions and keys
  scripts/                   build, validate, sign, index
  .github/workflows/         CI: check on PR, publish on merge
```

- **Listing metadata** (`marketplace.json`, outside the package so it can change
  without a new version):
  - title, a one-line summary, category, tags, icon, screenshots;
  - homepage, license, author;
  - `minOctipus`.
- **What is installed** is only `plugins/<name>/` minus `marketplace.json`.
  That is the tarball, and its content hash is what gets signed.

### CI

**On a pull request:**
1. `octi plugin validate` on every changed plugin, then its own tests.
2. A sandbox smoke run: start the server under bwrap and call `tools/list`.
3. A **permissions diff** against the published version: new host scopes,
   network hosts, tool effects, contributions, runtime, `model.trustedInput`.
   - Any widening adds the label `needs-security-review` and blocks merging
     until a maintainer reviews it.
   - `runtime: in-process` is refused outright; the marketplace carries
     package plugins only.
4. A license check and a size check against the host's install limits
   (200 MB, 20,000 files).

**On merge to `main` with a version bump**, CI only builds; it never signs
and never publishes:
1. **Build** the tarball reproducibly (sorted entries, fixed mtimes and owners).
2. **Record** each tarball's sha256 and content hash as a build artifact.
   CI holds no key.

**Publishing happens on the publishing machine** (see Signing below), with one
command, e.g. `npm run publish`:
1. Pull `main` and rebuild the tarballs reproducibly.
2. **Compare** the hashes with CI's record, and stop on any difference. A
   tampered CI or a tampered checkout cannot be signed without being noticed.
3. **Sign** each new package's content hash, then the index.
4. **Write** the site, the tarballs (`/dl/<name>-<version>.tar.gz`), and
   `index.json` with `index.json.sig` into one output directory. You deploy
   that directory to the web server for `plugins.octipus.cc`, the same way as
   octipus.cc.

The index keeps every published version of a plugin, not only the newest, so
a host can stay on an older version and a downgrade remains possible.

### The marketplace website: `plugins.octipus.cc`

The marketplace is a public website on a subdomain of octipus.cc, with **the
same design as octipus.cc**, so that it reads as part of the same site. It is
the place to discover plugins before installing them, and to link to them.

- **Built from `octipus-plugins`.** A static Astro site (octipus.cc is Astro)
  is generated from the plugins' `marketplace.json`, READMEs, changelogs and
  the computed permissions on every publish. It is hosted alongside
  octipus.cc on the same server, and that setup is done separately, after this
  plan. The same deployment serves the tarballs and the signed `index.json`,
  so everything a host downloads comes from `plugins.octipus.cc`.
- **Same design as octipus.cc:**
  - **Layout:** the site's own header, navigation and footer (`ocean-header`,
    `ocean-navigation`, `ocean-footer`), with Plugins as an entry next to Docs
    and GitHub, and octipus.cc linking back.
  - **Tokens:** deep ink `#071923`, panel `#0b222d`, lines `#29424a`, text
    `#edf4ed`, muted `#a6bec3`, sea glass `#92c9c5`, coral `#efa99b`, paper
    `#f0eee5`, max width 1180–1200px.
  - **Type:** Manrope 400–800, tight negative letter-spacing on headings.
  - **Surfaces:** soft corners (10–13px, pills at 100px), fine borders, blurred
    glass panels, soft deep shadows.
  - **Voice:** `docs/design/IDENTITY.md`, warm and practical; errors and
    permissions in direct language.

  The layout and tokens are shared with octipus.cc's source, not copied by
  eye, so a change to the main site reaches the marketplace (see Decisions).
- **Pages:**
  - **Home:** search, categories, and featured plugins (the examples first).
  - **One page per plugin:**
    - its README;
    - screenshots, served from the site itself;
    - **what it asks for**: host scopes, network hosts, tool effects,
      contributions and pages, in the same words the admin page uses;
    - its versions and changelog, publisher, signature and licence;
    - "Install in Octipus": Admin → Plugins → Marketplace, or
      `octi plugin install <name>`.
  - **Publish:** how to submit a plugin, and the review checklist (phase 5).
- **Static, no accounts, no tracking.** It sets no cookies and runs no
  analytics script. The site's CSP allows its own files and the Manrope font
  only.

The in-app Marketplace page (Host side 2) keeps the web app's own design. It
reads the same index and links to a plugin's page on `plugins.octipus.cc`.

### Index v2

This is backward compatible: v1 hosts read `name`, `version`, `description`,
`url` and `sha256` and ignore the rest.

```json
{
  "schema": 2,
  "generatedAt": "2026-11-10T12:00:00Z",
  "packages": [{
    "name": "weekly-review", "version": "1.2.0", "description": "…",
    "url": "https://plugins.octipus.cc/dl/weekly-review-1.2.0.tar.gz",
    "sha256": "<hex>", "contentHash": "sha256:<hex>", "apiVersion": "1.0.0", "minOctipus": "0.7.0",
    "title": "Weekly review", "category": "productivity", "tags": ["tasks", "notes"],
    "icon": "https://plugins.octipus.cc/weekly-review/icon.png", "screenshots": ["…"], "readme": "…", "changelog": "…",
    "publisher": "Octipus", "license": "MIT", "publishedAt": "…",
    "permissions": { "host": ["tasks:read", "notes:write"], "network": [], "effects": { "write": 1, "read": 2 },
                     "contributions": ["schedule"], "pages": 1, "trustedInput": false },
    "deprecated": null
  }],
  "revoked": [{ "name": "x", "version": "1.0.0", "reason": "…" }, { "keyId": "ed25519:…", "reason": "…" }]
}
```

`permissions` is computed from the manifest by CI. The host recomputes it from
the downloaded manifest and refuses the install when the two differ, so a
listing cannot understate what a package asks for.

### Host side

1. **Default registry.** Octipus ships the marketplace as a built-in registry
   entry, with `publisher: "Octipus"` and the marketplace public key in
   `trustedPublishers`. The registry URL is
   `https://plugins.octipus.cc/index.json`, and the index must be signed.
   - `plugins.marketplace: false` turns it off, for air-gapped installs and
     organisations with their own registry.
   - Other registries keep working as now.
2. **Marketplace page** (Admin → Plugins → Marketplace, replacing Browse):
   - search, categories and tags, and "installed" or "update available" badges;
   - a detail view with the README and changelog, rendered sanitized with no
     remote images;
   - screenshots fetched through the host and served from it;
   - the permissions **before** install, in the same words as the enable
     confirmation;
   - publisher and signature state.

   Install stays "installed disabled, then approve", so nothing about trust
   changes.
3. **Updates.** A daily index check (it already caches) notifies admins of
   new versions, with a **permissions diff** between the installed version and
   the new one. Upgrades are never automatic, because an upgrade clears the
   approvals by design.
4. **Online revocation.** The signed index's `revoked` list is applied like
   the config's `revoked` and `revokedKeys`:
   - a revoked version or key is refused at install and at start;
   - an installed row shows why;
   - admins are notified.

   The last good index is kept, so revocation still holds when the
   marketplace is unreachable.
5. **Provenance.** The install's audit row and the package view record
   `source: marketplace:<registry>` and the listing version. The admin page
   shows "From the marketplace" next to the existing "Authored by an agent".
6. **Compatibility.** `apiVersion` (exists) and `minOctipus` (new) are checked
   at listing, so incompatible versions show as unavailable, and again at
   install.

### The examples

`reader` and `research` stay in `plugins/` as the offline, always-available
examples and reference implementations. They are also published to the
marketplace from the same source by a sync job, so the copy in the repository
and the published one cannot drift. A marketplace version of a shipped example
is an ordinary upgrade.

## What a marketplace signature means

The signature says that "this exact content passed CI and a maintainer's
review". It does not say that the code is safe. The host's guarantees stay
what they are: the sandbox, declared network hosts, host scopes with admin
approval, tool effects and the user's permission rules, protection levels and
budgets. The docs and the detail page say so.

## Gaps to close, from the research plugin work

**Needed for the first release:**
- Default registry and a shipped publisher key (Host side 1), and the examples
  signed by it.
- A per-plugin usage view: the tokens and spend of `model:complete` and
  `agent:run` for each package and user. The cost rows are already tagged
  `plugin:<name>`, so this is a page, not new accounting.
- Cancelling a plugin's background run (`DELETE /api/plugin-host/agent/runs/:id`).

**Later:**
- Plugins listing their own documents and runs.
- Page state between visits (a small per-user key-value store through the
  bridge).
- Deep links to a run.
- Runs and pages in spaces.
- Per-scope cost and limit metadata on the admin page.
- Partial grants (approving some scopes of a version).

## Phases

1. **Registry and website:**
   - the repository layout and the CI checks;
   - reproducible builds, and the local publish command (hash check, signing,
     output directory);
   - index v2, encrypted keys and the backup key;
   - the `plugins.octipus.cc` site in the octipus.cc design, serving the
     index.

   The reader and research are published from there.
2. **Host:** the default registry and key, index v2 parsing with the
   permission cross-check, `minOctipus`, and provenance.
3. **Marketplace page:** search and categories, the detail view, permissions
   before install, update badges and the permissions diff.
4. **Updates and revocation:** the daily check, admin notifications, online
   revocation, and the usage view.
5. **Community:** a submission guide and template, the review checklist,
   publisher pages.
   - Third-party publishers either submit to `octipus-plugins` and are signed
     by the marketplace key, or run their own signed registry that admins add.

## Signing

**The key lives on the publishing machine, not on GitHub and not on the web
server.**

- **Not on GitHub:** a GitHub secret can be read by any workflow that a
  merged change can alter. The marketplace signature is the one thing that
  makes a package installable on every Octipus host, so it should not depend
  on the review of every future workflow change.
- **Not on the web server:** that process faces the internet. A compromise
  there should be able to deface the site, but never to sign.
- **Encrypted at rest.** `octi plugin keygen --passphrase` writes the private
  key as passphrase-encrypted PKCS#8 (`node:crypto`, no new dependency).
  `sign` and `sign-index` ask for the passphrase, or read it from a file
  descriptor for scripts. This is a small addition in phase 1; today's key
  file is unencrypted.
- **A second, backup key.** It is generated at the same time and kept offline
  (a password manager or a USB stick in a drawer), and never used to sign
  packages. Both public keys ship in Octipus's built-in `trustedPublishers`
  entry.
  - If the active key is lost or leaks, the backup key signs an index whose
    `revoked` list names the old key and that starts signing with a new one.
  - No Octipus host needs an update to keep working.
  - The host accepts a revocation signed by any trusted marketplace key, and
    a revocation cannot be undone by the revoked key.
- **Later, optional:** a hardware key such as a YubiKey. It needs a signing
  path that calls the token instead of reading a file; not now.

## Decisions

- **Subdomain:** `plugins.octipus.cc`.
- **Hosting:** your own server, next to octipus.cc. You pull the repository
  and set up the site and the subdomain after this is built.
- **Key custody:** the publishing machine, with an encrypted key file and an
  offline backup key (Signing, above).

Still open:
1. **Who may publish.**
   - Recommended for now: first-party only (you and maintainers).
   - Open community submissions are phase 5.
2. **Sharing the octipus.cc design.** Its source is not in the repositories
   this work can see.
   - Recommended: move the site's layout (header, navigation, footer) and
     tokens into a small shared package, or a `design/` folder the site and
     the marketplace both import, so there is one source.
   - Until then, the marketplace copies them from the published site, and
     that copy is replaced once the source is shared.
3. **The examples in the marketplace too.**
   - Recommended: yes, from the same source (above).

## Not doing

- Ratings and reviews, and paid plugins.
- `in-process` plugins in the marketplace; they stay a deliberate local
  install.
- Auto-updates.
- Trust delegated to the registry: what installs is decided by the package's
  own signature and the admin's approvals, as today.
