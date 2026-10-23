# Scan folders

A scan folder is a directory on the Octipus server that a scanner, a
fax-to-file service or a network share drops files into. Every file that
lands there is filed into the documents of a scope (personal or a space),
where it goes through the usual processing (OCR, category, summary), and is
then removed from the folder: the document keeps the file. This is point C4 of the
[business OS plan](plans/business-os.md).

Mail is the other way in: a mail account can file the attachments of the mail
it receives ([MAIL.md](MAIL.md#filing-attachments)). This is the path for
fax-to-mail and scan-to-mail.

## Setting one up

Admins only, because the path is the server's file system. A folder files
into the scope it is set up in:

- set up personally, it files into the admin's own documents;
- set up in a space (with the space's workspace header), it files into the
  space's documents. The admin must be an owner or editor there.

`POST /api/scan-folders`:

```json
{ "path": "/srv/scans/reception", "label": "Scanner reception" }
```

| Field | Meaning |
|---|---|
| `path` | An absolute path to an existing directory. Octipus needs to read it and to move files out of it. It is stored resolved, with no symbolic link left in it. |
| `label` | Shown on the documents (`metadata.scanFolder`) and in the list. |
| `enabled` | Off stops filing; files stay where they are. |

### Paths

A scan folder files everything put into it, so some directories are refused:

- the root directory and system directories (`/etc`, `/proc`, `/sys`, `/dev`,
  `/boot`, `/root`, `/bin`, `/sbin`, `/usr`, `/lib`, `/opt`, `/var/lib`,
  `/var/log`, `/run`, and their macOS and Windows counterparts), and anything
  inside them;
- hidden directories and anything inside one (`~/.ssh`, `~/.config`);
- Octipus's own data and code (the workspace, the documents directory, the
  embedded database, `~/.octipus` with its extensions and skills, the install
  directory), whether the folder is inside it or contains it. Every path is
  compared with symbolic links resolved;
- a directory Octipus cannot read and write;
- a directory that is already a scan folder.

`GET /api/scan-folders` lists the folders with their last scan, last error and
how many files they have filed. `PATCH /api/scan-folders/:id` changes them,
`DELETE` removes one (its files stay on disk), and `POST /:id/scan` files now.
All of these need an admin. A scan that is already running is not started
twice (409), and a disabled folder is not scanned.

A folder stays with the admin who set it up: it does not move with a workspace
transfer, and it files nothing once its author is no longer an admin or can no
longer write in its scope.

## Sweep

Every cron tick (once a minute) each enabled folder outside an archived space
is looked into:

- **What is taken:** regular files directly in the folder, with a single
  link, whose change time is more than 30 seconds old (so a scan still being
  written is left to finish; the change time cannot be set back the way a
  modification time can). Hidden files, `.part`, `.tmp`, `.crdownload` and `~`
  files, subdirectories, symbolic links, hard links, pipes and devices are
  left alone. A file is opened without following links and without blocking,
  and read only up to the upload limit (`workspace.maxUploadSize`).
- **As whom:** the admin who set the folder up, resolved again each time: still
  active, still an admin, still able to write in the scope. Otherwise nothing
  is filed and the folder says why.
- **Once:** the same content is filed once per folder, so a scan dropped twice
  is filed once.
- **Afterwards:** a filed file (or a repeat) is removed from the folder, after
  checking the name still is the file that was read. Octipus creates and moves
  nothing inside the folder, so nothing planted there can redirect a write.
- **Failures:** a file that cannot be filed (too large, a hard link, unreadable)
  stays where it is and the folder shows why. It is not tried again until it
  changes.
- At most 50 files and 2,000 directory entries per folder per tick, the folders
  scanned longest ago first; the rest follow.

Filed documents carry `metadata.source = "scan_folder"` and the folder's id and
label.

## Not yet

- A web page for scan folders.
- Rules that route a document to a case or a record type by its content
  (the privacy gateway, C6, and the document pipeline decide what reaches a
  model).
- Watching subdirectories.
