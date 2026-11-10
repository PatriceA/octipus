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

**On merge to `main` with a version bump:**
1. **Build** the tarball reproducibly (sorted entries, fixed mtimes and owners).
2. **Sign** the content hash, then the index, in a protected GitHub
   environment with a required maintainer approval. The private key exists
   only there (see Decisions).
3. **Publish** the tarball as a GitHub Release asset (`<name>-v<version>`), and
   the index with its `.sig` on GitHub Pages, at
   `https://patricea.github.io/octipus-plugins/index.json`.

The index keeps every published version of a plugin, not only the newest, so
a host can stay on an older version and a downgrade remains possible.

### Index v2

This is backward compatible: v1 hosts read `name`, `version`, `description`,
`url` and `sha256` and ignore the rest.

```json
{
  "schema": 2,
  "generatedAt": "2026-11-10T12:00:00Z",
  "packages": [{
    "name": "weekly-review", "version": "1.2.0", "description": "…",
    "url": "https://github.com/PatriceA/octipus-plugins/releases/download/weekly-review-v1.2.0/weekly-review-1.2.0.tar.gz",
    "sha256": "<hex>", "contentHash": "sha256:<hex>", "apiVersion": "1.0.0", "minOctipus": "0.7.0",
    "title": "Weekly review", "category": "productivity", "tags": ["tasks", "notes"],
    "icon": "…/icon.png", "screenshots": ["…"], "readme": "…/README.md", "changelog": "…/CHANGELOG.md",
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
   `trustedPublishers`. The index must be signed.
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

1. **Registry:** the repository layout, the CI checks, reproducible builds,
   signing in a protected environment, Releases and Pages publishing, and
   index v2. The reader and research are published from there.
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

## Decisions to make

1. **Key custody.**
   - Recommended: the marketplace private key lives only as a secret of a
     protected GitHub environment, and every publish needs a maintainer's
     approval.
   - Alternative: maintainers sign offline and push the `.sig` files. That is
     stricter but slower.
2. **Who may publish.**
   - Recommended for now: first-party only (you and maintainers).
   - Open community submissions are phase 5.
3. **Hosting.**
   - Recommended: GitHub Releases for the tarballs and GitHub Pages for the
     index. The host's remote install follows up to three https redirects,
     which covers Releases.
4. **The examples in the marketplace too.**
   - Recommended: yes, from the same source (above).

## Not doing

- Ratings and reviews, and paid plugins.
- `in-process` plugins in the marketplace; they stay a deliberate local
  install.
- Auto-updates.
- Trust delegated to the registry: what installs is decided by the package's
  own signature and the admin's approvals, as today.
