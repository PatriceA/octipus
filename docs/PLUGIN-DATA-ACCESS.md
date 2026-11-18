# Plugin data access: user and agent guide

A plugin protection refusal is a data-access decision, not a missing shell permission.
Do not repeat the failed tool, change the data's label to make it run, or edit the
plugin's signed files. An administrator manages data access in the Octipus UI.

## Guide the user

1. **Keep the existing classification.** Public is level 1, Internal is level 2,
   Confidential is level 3 and Strictly confidential is level 4. A conversation
   keeps the highest level it has read. A new conversation does not make internal
   repository or ticket evidence public.
2. **Identify the plugin and the allowed level from the refusal.** Explain the
   mismatch in plain words: “This chat contains Internal data, but this plugin is
   currently allowed Public data only.” Check current configuration before claiming
   that approval is possible. A tool refusal is not a reason to switch execution
   routes and evade the restriction.
3. **Open Settings → Administration → Plugin packages → the plugin → Data access.** A direct
   link is `/admin/plugins?dataAccess=<plugin-name>`. A non-admin asks an administrator
   to make this choice; an agent does not grant itself access. The UI shows the
   package default, current owner setting, configurable maximum and the reason for
   any capability limit.
4. **Choose the true classification and trusted connections.** For an internal
   release audit, choose Internal and only the existing Git/tracker/forge connections
   needed for that project. Repository folders and ordinary tool/connection
   permissions still apply. Connection names, origins and path prefixes are shown;
   credentials stay in the vault. Save data access once, rather than approving a
   list of individual commands.
5. **Use the protected view or the existing conversation.** The protected view is
   rendered by Octipus and runs no plugin browser code. Its tool forms handle ordinary
   arguments; structured results are displayed as text and tables. Complex setup can
   be described in the existing session instead of editing JSON. This generic view
   is a tools workspace, not a reproduction of every plugin's custom dashboard.
6. **Retry only the unfinished operation after access changes.** Check any earlier
   run/receipt first. A protection refusal itself does not prove that other steps
   failed. Do not repeat completed installs, start duplicate audits or claim a new
   audit passed merely because access is now configured.

The data approval is separate from plugin source. An installed package that declares
Public as its default can receive an explicit owner approval for Internal data in
chat and the protected view without a code edit, re-signing or marketplace update.

## What each limit means

- **Package with no outbound data capability:** the protected view can support up to
  level 4, subject to the owner's chosen level and ordinary content permissions.
- **Named connection reads or repository collection:** Internal can be approved for
  selected destinations. Other connections remain outside that approval. The origin
  and path prefix are pinned, so an edited destination needs a new decision.
- **Direct network, arbitrary web access, remote model/agent work or sending mail:**
  these capabilities still limit the package to Public in this workflow. Do not tell
  the user that clicking approve will remove such a limit. Explain the displayed
  reason and choose a compatible workflow. Redesigning a plugin or changing Octipus
  is a last resort when the available controls genuinely cannot express the need.
- **Custom plugin browser pages:** these remain Public-only. An explicit data-access
  policy uses the Octipus protected view; the old page bridge cannot retrieve
  protected tool results or store entries.

## Saved data, updates and recovery

Saving a higher classification raises the plugin's existing saved entries; it never
lowers them. Reducing access withholds records above the new limit rather than making
them Public. Data remains scoped to its user and workspace.

Approval covers the reviewed package content hash. After a package update, the old
approval is not silently transferred to different code: the Data access panel explains
that review is needed. Saved protected records are retained while access is renewed.
Changing a trusted connection's destination also requires review. Disabling the global
protection module is not the normal repair for a single plugin.

## Release reconciliation example

The original release-reconcile package declares `maxProtection: 1` and uses
`repos:collect`. That does not require patching the package for each installation.
An administrator approves Internal in **Data access**, selects the already configured
Git, Jira and forge connections, and keeps the approved repository folders. Repository
collection is classified at least at that owner-selected level. The same existing
level-2 conversation can then use the package, and the protected view can display its
results. This setting changes neither tags, branches nor tickets by itself.

## Agent lookup checklist

Use `knowledge.search_product_docs` with the plugin name and refusal, for example
`release-reconcile level 2 protection audit blocked`. Open this guide with
`knowledge.read_product_doc` (`path: "PLUGIN-DATA-ACCESS.md"`). These tools search
the bundled manual locally; they need neither an embedding model nor an external
knowledge service.

When `plugin_dev.plugin_api` is available, an administrator's agent can pass
`installedPlugin: "release-reconcile"` (or the actual installed name) to inspect
current data access, the supported maximum and its settings link. This is read-only;
it does not approve anything. For a non-admin, explain who must make the decision.
If the tools are unavailable, say that configuration is unverified and give the UI
steps; do not guess the current policy or start a coding session to change it.

## Agent reporting

State what was observed: policy saved, readiness check passed, an existing report
opened, or a fresh audit completed are different outcomes. If a capability still
prevents the requested level, give the exact reason and the available UI option.
Do not say “the admin must approve level 2” when that capability combination cannot
support level 2. Do not request private keys, vault tokens or passwords in chat.
