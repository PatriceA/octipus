# Scan folders

A scan folder is a directory on the Octipus server that a scanner, a
fax-to-file service or a network share drops files into. Every file that
lands there is filed into the documents of a scope (personal or a space),
where it goes through the usual processing (OCR, category, summary), and is
then moved out of the way. This is point C4 of the
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
{ "path": "/srv/scans/reception", "label": "Scanner reception", "afterFiling": "move" }
```

| Field | Meaning |
|---|---|
| `path` | An absolute path to an existing directory. Octipus needs to read it and to move files out of it. It is stored resolved, with no symbolic link left in it. |
| `label` | Shown on the documents (`metadata.scanFolder`) and in the list. |
| `afterFiling` | `move` (default): a filed file goes to `.octipus-done/<date>/` inside the folder. `delete`: it is removed. |
| `enabled` | Off stops filing; files stay where they are. |

### Paths

A scan folder files everything put into it, so some directories are refused:

- the root directory and system directories (`/etc`, `/proc`, `/sys`, `/dev`,
  `/boot`, `/root`, `/bin`, `/sbin`, `/usr`, `/lib`, `/var/lib`, `/run`, and
  their macOS and Windows counterparts), and anything inside them;
- Octipus's own data (the workspace, the documents directory, the embedded
  database), whether the folder is inside it or contains it;
- a directory Octipus cannot read and write;
- a directory that is already a scan folder.

`GET /api/scan-folders` lists the folders with their last scan, last error and
how many files they have filed. `PATCH /api/scan-folders/:id` changes them,
`DELETE` removes one (its files stay on disk), and `POST /:id/scan` files now.
All of these need an admin.

## Sweep

Every cron tick (once a minute) each enabled folder outside an archived space
is looked into:

- **What is taken:** regular files directly in the folder that have not
  changed for 30 seconds (so a scan still being written is left to finish).
  Hidden files, `.part`, `.tmp`, `.crdownload` and `~` files, subdirectories
  and symbolic links are left alone. A file is opened without following
  links, so one swapped for a link at the last moment is refused.
- **As whom:** the admin who set the folder up, resolved again each time. If
  they were deactivated, left the space or can no longer write there, nothing
  is filed and the folder says why.
- **Once:** the same content is filed once per folder, so a scan dropped twice,
  or a file that could not be moved aside, is not filed again.
- **Afterwards:** a filed file (or a repeat) is moved to `.octipus-done/<date>/`
  or deleted. One that could not be filed (larger than the upload limit
  `workspace.maxUploadSize`, unreadable) goes to `.octipus-failed/<date>/`,
  and the folder shows the error. Moved back into the folder, it is tried
  again.
- At most 50 files per folder per tick; the rest follow.

Filed documents carry `metadata.source = "scan_folder"` and the folder's id and
label.

## Not yet

- A web page for scan folders.
- Rules that route a document to a case or a record type by its content
  (the privacy gateway, C6, and the document pipeline decide what reaches a
  model).
- Watching subdirectories.
