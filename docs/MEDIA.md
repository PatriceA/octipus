# Images and audio

Agents look at images, read scanned documents, hear and speak. Each of these
is **optional**: what is not configured is not offered. An agent never sees a
tool that cannot work, and a feature without a model is hidden or says plainly
that it is off ([MODULES.md → Capability gates](MODULES.md#capability-gates)).

| Need | Served by | Off when |
|------|-----------|----------|
| **see** — look at an image | the agent's own model if it reads images; else the **Vision** lane; else the default model if it reads images | none of them reads images |
| **ocr** — read a scan | the **OCR** lane; else Vision; else the default model if it reads images | none of them |
| **hear** — speech to text | the **Transcription** lane ([VOICE.md](VOICE.md)) | nothing bound |
| **speak** — text to speech | the **Speech** lane ([VOICE.md](VOICE.md)) | nothing bound |

One resolver decides (`src/models/media-resolver.ts`); the Topics page and
Health show what actually serves each lane. Protection levels apply: content
that stays local is only read by a local model (seeing and OCR switch to one;
speech refuses a cloud engine and uses a local backup).

## Does a model read images?

A model row's **Reads images** (`supportsVision`) and **Hears audio**
(`supportsAudioInput`) flags. They are detected when a model is added: Ollama
answers itself (`/api/show` capabilities); other providers use a
conservative table of model families that only ever turns a flag **on**. A
flag set by hand is never turned off. Edit the model to correct it.

## An image in the chat

What happens to an image a user attaches (web chat, TUI, or a channel —
Telegram, Slack, WhatsApp, Teams):

| The model doing the work | It gets |
|--------------------------|---------|
| reads images | the image itself, with the message (a copy ≤ 2048 px, ~300 KB; the original is untouched) |
| cannot read images, calls tools | the file's path; it decides whether it needs to look, and calls `vision__view_image` with its own question |
| cannot call tools | a description written up front by the Vision lane |
| a CLI agent | the original file, to open with its own reader |
| nobody on the install can see | a line saying the image was not seen, so it says so instead of guessing |

`media.imageInput = describe` (Settings → Media) always describes up front.

Images stay in the conversation: after a restart a follow-up ("what colour
was the car?") still has them. Only the newest `media.replayRecentImages`
(default 3) image-bearing messages are re-sent as pixels with each request;
older ones become a line the model can look again from.

On a channel, an image sent alone reaches the agent as an image (with or
without a caption). It is not filed in the document library unless
`media.fileChannelImages` is on, or it came with documents.

## Tools

**`vision`** (in the general agent's core set; also research, writing,
communication, design, coding, review, qa):

- `view_image({ source, question?, region? })` — `source` is a workspace or
  attachment path or an http(s) URL (fetched through the SSRF guard, at most
  25 MB). `region` crops first, in pixels of the original.
  - A model shown images after a tool result gets the pixels ("you can see it
    now"). Mistral takes images in a user turn but not after a tool result:
    there, and with `media.imageInput = describe`, the Vision lane looks.
  - A model that cannot see gets the Vision lane's answer to its question,
    marked as another model's output.
  - A CLI agent gets the file.
  - The same image more than three times in one run is refused.
  - Offered when the agent's own model can be shown images, or some model can see.
- `read_document_text({ path })` — the text of a scan, a photo of a page, an
  image or a PDF, now, through the OCR route of the document pipeline.
  Offered when something can read scans.

Screenshots (`browser__screenshot`, `browser-ext__screenshot`) and images an
MCP server returns are saved in the workspace (`.octipus/media/…`) and shown
the same way: pixels for a model that is shown images, the path for one that
is not. Base64 never goes into the conversation.

Text inside images, audio and documents is content, not instructions: the
prompts say so and every description is marked as model output.

## Conformance

`image-in-message` and `image-after-tool-result` (Models → Test) check that a
provider takes an image in a chat turn and after a tool result. A provider
that rejects the second is listed in `acceptsImagesAfterToolResults`
(`src/models/providers/media-content.ts`).

## Settings

| Key | Default | What |
|-----|---------|------|
| `media.imageInput` | `auto` | `auto`/`native`: as above. `describe`: describe every image up front. |
| `media.replayRecentImages` | 3 | How many image-bearing messages keep their pixels. |
| `media.fileChannelImages` | off | Also file images sent alone on a channel as documents. |
