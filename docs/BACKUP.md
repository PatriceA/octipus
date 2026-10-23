# Backups

Octipus backs itself up every day: the database, which holds the vault, and
the workspace files. Each backup is checked by loading it back before it
counts. This is point C5 of the [business OS plan](plans/business-os.md).

## What is in a backup

A backup is a directory `backup.path/<id>/`, for example
`~/.octipus/backups/20261023T020000Z/`:

| File | What |
|---|---|
| `database.tar.gz` (embedded mode) | PGlite's data directory. |
| `database.dump` (external mode) | `pg_dump --format=custom` of the database. Needs the PostgreSQL client tools on the server. |
| `files-1.tar.gz`, `files-2.tar.gz` | One archive per directory, each holding that directory's contents: the workspace root (documents, space files, plugin packages), and the documents directory when it lies outside the root. The backup directory and the embedded database directory are left out; the database is in its own file. Off with `backup.includeFiles: false`. |
| `manifest.json` | What the backup holds: when it was made and why, the Octipus version, the storage mode, each file's size and SHA-256, the number of vault rows, and the outcome of the check. |

The **vault** is in the database: every secret encrypted under the master key.
The master key is **never** written into a backup. Without it the vault in a
backup cannot be read, so keep it apart and safe:
- `MASTER_KEY` in `.env`;
- `.env.compose` for Docker.

Backups hold business data in the clear (documents, mail, records). Their files
are readable by the Octipus user only (mode 0600, directories 0700). Copy them
off the machine (a NAS, an encrypted off-site store) with the tools you
already use.

## The check

A backup counts only after it was loaded back:

- Every file's checksum.
- **Embedded:** the database is loaded into a fresh in-memory PGlite. The vault
  rows are counted against the manifest, and a few of them are decrypted with
  the current master key. A backup whose vault the key cannot open fails.
- **External:** `pg_restore --list` reads the dump, and the vault's data must be
  in it. The key is checked against the live database while the backup is
  written.
- Each files archive is listed with `tar`. Only GNU tar's "a file changed while
  it was read" (exit code 1) is accepted while writing; any other tar error fails
  the backup.

A backup that fails its check is removed and does not count. Checking a backup
again later (`verify`) records the outcome beside the first check and never
undoes it. A key rotated since, or a missing tool, does not make an older good
backup look bad and get it removed.

## Schedule and retention

| Key | Default | Purpose |
|---|---|---|
| `backup.enabled` | `true` | Run the daily backup. Env: `BACKUP_ENABLED`. |
| `backup.path` | `~/.octipus/backups` | Where backups go. Put it on another disk. Env: `BACKUP_PATH`. |
| `backup.hour` | `2` | The hour (server time) the backup runs. Env: `BACKUP_HOUR`. |
| `backup.keep` | `7` | Good backups kept. Env: `BACKUP_KEEP`. |
| `backup.includeFiles` | `true` | Include the workspace files. Env: `BACKUP_INCLUDE_FILES`. |

- **One scheduled backup per day**, at `hour`:00 server time. If the server was
  down at that time, it runs on the next tick. Manual backups do not stand in
  for it. A failed scheduled run counts for its day: the admins were told, and
  the next day tries again.
- After a good backup, only the newest `keep` good backups stay. Older ones go,
  and so do leftovers of runs that never finished. A run of failures never
  removes the last good backup.
- **A failed backup tells every admin** (a `backup_failed` notification) and is
  recorded in `backup.path/last-run.json`.

## Admin API

| Method and path | What |
|---|---|
| `GET /api/backups` | The settings, whether a backup is running, the last run, and every backup with its manifest |
| `POST /api/backups/run` | Start a backup now (202); its outcome shows in `lastRun` |
| `POST /api/backups/:id/verify` | Check a backup again |

## Command line

```bash
npm run backup                         # write and check a backup now
npm run backup -- list                 # the backups and whether they were checked
npm run backup -- verify 20261023T020000Z
npm run backup -- restore 20261023T020000Z [--database] [--files] [--to /tmp/restore] [--force]
```

**Restore with the server stopped.** Restore checks the backup first, then:

- **Embedded:** extracts the database into the database directory (`DATA_DIR`).
  The directory must be empty or missing, so move the old one aside first.
- **External:** `pg_restore --clean --if-exists` into `DATABASE_URL`. This
  replaces the tables there, so it runs only with `--force`.
- **Files:** extracts each archive to the directory it came from, which must be
  empty or missing. With `--to <dir>`, they go into numbered subdirectories of
  that directory, which must be empty too, so you can pick from them.
- Restored directories are readable by the Octipus user only.

Restore needs the same master key the backup was written with.

## Not yet

- Encrypting backups with their own key, and copying them off the machine.
- A web page (the API is there).
- Warm standby on a second machine (plan point C13).
- **The dump runs inside the server process.** For an embedded database it reads
  the whole data directory at once and briefly holds up requests. Large or busy
  installs should use external PostgreSQL. That is one reason the backup runs
  at night.
- One scheduled run per install: with several server processes on one
  database, each would run it.
