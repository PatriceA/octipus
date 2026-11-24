# To-dos, notes and your day

This guide is for using Octipus as your daily to-do list and notepad. Three
pages work together:

| Page | What it is for |
|---|---|
| **Today** (sidebar, at the top) | Your day on one page: what is overdue, due today or in My Day, today's calendar, and today's note. |
| **To-dos** | Every list: My Day, Important, Planned, All, Completed and your own lists. A to-do opens in a panel on the right. |
| **Notes** | A notepad: open a note and type. It saves itself. |

The API behind all of this is in [API.md](../API.md#note--to-do-links).

## A day with Today

Open **Today** in the morning.

- **To-dos.** Overdue ones come first, then those due today, then the ones
  you put in **My Day**. Type in the box at the top and press Enter to add one
  for today ("call the dentist tomorrow 3pm !high #personal" works: the chips
  show what was understood). Tick one off and it moves to **Done today**.
  **Still open from earlier** offers what you picked yesterday and did not
  finish; add one, or all of them, to today.
- **Calendar.** Today's events from your connected Google or Microsoft 365
  calendars, with a Join button for online meetings. Without a connected
  calendar it says so and links to connecting one. In a shared space your
  calendars stay private: switch to your personal workspace to see them.
- **Today's note.** The day's note, ready to type into. Opening the page does
  not create it: the first thing you type does. **Jot a line** below it adds a
  timestamped line without moving your cursor.

Press **Q** on any page to add a to-do, or type into the search bar (Ctrl+K)
and pick **Add to-do** or **Add … to today's note**.

## Turning notes into to-dos

Write a checklist line in any note:

    - [ ] Send Ada the draft

Then, with the cursor on that line, press **⌘⇧Enter** (Ctrl+Shift+Enter on
Windows and Linux), click **+ To-do** at the end of the line, or use the
to-do button in the toolbar. A plain line or a list item becomes a checklist
line first. The line now shows a small **To-do** chip; click it to open the
to-do. In the reading view the same chip shows, **+ To-do** is offered on each
checklist line, and selecting some text offers **Make a to-do** of it (the
to-do is titled with the selection and the note is attached to it).

From then on the two follow each other:

- Tick the line in the note and the to-do is completed (when the note saves,
  a moment later). Complete the to-do anywhere — the to-do list, Today, your
  phone, an agent — and the line is ticked in the note.
- The note's **context panel** (the panel button at the top right) lists its
  to-dos, with a box to tick each and a click to open it.
- Delete the line and the to-do stays (still linked to the note). Edit the line
  and the to-do keeps its own title.
- Delete the to-do and the line stays as it is; ticking the line does not
  bring a deleted to-do back.
- A repeating to-do: the line belongs to the occurrence it was made from and is
  ticked when that is done; the next occurrence has the note attached.
- If the note changed somewhere else while you were typing (a to-do ticked its
  line, another device saved it), your text and that change are merged and
  saved. Only when both changed the same words are you asked which to keep.

To-dos you make from today's note on the Today page go straight into My Day.

## Notes on a to-do

Open a to-do. Its panel shows:

- **Notes** — free text in Markdown: `**bold**`, lists, and links like
  `[the brief](https://example.com)`. It shows formatted; click it to edit.
- **Linked notes** — chips for the notes it is linked to. Click one to open
  the note. **Attach a note** finds a note by name or creates a new one with
  the name you typed. The **x** on a chip unlinks it (the note stays). In the
  lists, the to-do's grey line under its title names the note too.

## Asking an agent

The agent sees the same links:

- "What's on my plate today?" — it lists what Today shows (overdue, due today,
  My Day, done today and yesterday's unfinished picks), each with its notes.
- "Make to-dos from my meeting note" — every open checklist line of the note
  becomes a to-do linked to its line, as if you had pressed ⌘⇧Enter on each.
  In a shared space where the agent only suggests changes to notes, it makes
  the to-dos and attaches the note without changing its text.
- When it reads a note it sees the note's to-dos.

## In a shared space

Today, to-dos and notes work the same in a space, with the space's to-dos and
notes. My Day and stars stay yours. A to-do and a note can only be linked
within one place: your own to-dos with your own notes, a space's with the
space's. Someone who cannot open a note never sees its name on a to-do (a
guest sees only the notes in their folders), and the other way round.
