# Reader (Article / Page Rewrite)

> Design note, 2026-06-01. Feature #4 from `end-user-enrichment-plan.md`.
> A clean, distraction-free reading view with AI actions on top. Thin backend
> (we already fetch + extract pages); the value is the focused UI + the
> one-click AI transforms that turn "a wall of web page" into something useful.

## What we already have
- **`websearch.fetch_page`** — fetches a URL via headless browser and extracts
  text content (JS-rendered pages included), behind the H3 SSRF guard.
- **RAG / summarize** — embedding + summarization plumbing for "summarize this".
- **Artifacts host** + **documents** subsystem — to save/render reader output.
- **Vision models** (topic `vision`) — for image-heavy pages / screenshots.

## Goal & non-goals
**Goal:** paste a URL (or "read this" in chat) → get a clean readable rendering
of the main content, with one-click AI actions: **summarize, simplify
("explain like I'm 10"), translate, extract action items → Tasks (#6), Q&A
against the page**. Save to documents or send to chat.

**Non-goals:** a full read-it-later service (queues, folders, sync), browser
extension capture (the browser-ext tool is separate), offline archiving.

## Design
### Backend (small)
- A **main-content extractor**: `fetch_page` already returns page text, but for
  a *reader* we want article-quality extraction (drop nav/ads/footers, keep
  headings/images/links). Add a readability-style extractor — a small library
  (e.g. a Mozilla-Readability-class extractor) or ~100 lines of heuristics over
  the fetched DOM/HTML. Returns:
  ```
  ReaderDoc {
    url, title, byline?, siteName?, publishedAt?
    contentHtml   // sanitized, reader-formatted
    textContent   // plain, for AI actions
    leadImage?, wordCount, estReadMinutes
  }
  ```
- **Sanitize** the extracted HTML through the artifacts CSP/sanitizer before
  rendering (same posture as hosted artifacts — never render raw remote HTML).
- **AI actions** are existing capabilities applied to `ReaderDoc.textContent`:
  summarize/simplify/translate via the model registry (topic-bound, rule #2);
  "extract action items" produces Tasks (#6); "ask about this" is a scoped
  chat turn with the page as context.

### Surface
- **Web**: a `web/app/reader/` destination — URL input → `ReaderDoc` rendered in
  a centered, typographic reading column (light/dark, font-size control); a
  toolbar of AI actions; "Save to documents" / "Send to chat" / "Create tasks
  from this".
- **Chat**: "read <url> and summarize" routes through the reader extractor then
  the requested action; the cleaned article can open in the file view (#2).

## Security
- Reuses the **H3 SSRF guard** (`fetch_page` already validates + post-connect
  checks the address) — no new outbound surface.
- Remote HTML is **sanitized** (artifacts sanitizer) before render; no inline
  scripts, CSP-enforced.
- Reader is read-only; no new write/trust surface.

## Testing
- **Extractor**: unit tests against captured HTML fixtures (a few real article
  shapes + a JS-heavy one) → assert title/byline/wordCount and that nav/ads are
  stripped. Pure given HTML input.
- **Sanitizer**: assert scripts/event-handlers are removed (reuse artifacts CSP
  tests' approach).
- AI actions reuse existing summarize/translate paths — no new model tests.

## Sequencing
1. `ReaderDoc` extractor + sanitizer + fixture tests (backend only;
   `octi`/API returns a ReaderDoc).
2. Web reader destination (render + typography + actions).
3. Chat integration + "create tasks from action items" (after Tasks #6 exists).

## Dependencies
- **Tasks (#6)** for "extract action items" (degrade to "copy list" until then).
- **File view (#2)** to open the cleaned article (optional; nice-to-have).
- Pairs with **Deep Research (#5)** — research cites sources; reader lets the
  user actually read one cleanly.
