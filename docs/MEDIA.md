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
speech refuses a cloud engine and uses a local backup). Pixels and recordings
are never pseudonymized, so the strict threshold holds for them: at a
local-only level a remote model gets a line instead of the image (it can ask
`view_image`, which a local model answers), even where
`protection.remoteAtLevel3` lets text go out.

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

Only media files of the agent's own workspace (`.octipus/media`,
`.octipus/attachments`) are ever read into a request, and only when their
bytes are the kind they claim.

On a channel, an image sent alone reaches the agent as an image (with or
without a caption). It is not filed in the document library unless
`media.fileChannelImages` is on, or it came with documents.

## A recording in the chat

An attached recording (web chat, TUI: MP3, WAV, M4A, OGG/Opus, WebM, FLAC,
AAC, AMR) is transcribed with the turn by the Transcription lane, within the
session's protection level; the model gets the transcript and the file's
path. A recording over 25 MB is left for `audio__transcribe_audio`. With
`media.audioInput = native`, a model that hears audio (*Hears audio*) also
gets the recording itself (WAV or MP3, at most 10 MB, sent with its own turn
only; never confidential content to a remote model). Without a transcription
engine the model is told the recording was not transcribed.

Channel voice notes are transcribed the same way and kept with the
conversation (`.octipus/attachments/…`), so the agent can transcribe,
forward or keep them.

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

**`audio`** (general — core —, research, writing, communication):

- `transcribe_audio({ source, language?, timestamps? })` — a recording in the
  workspace through the Transcription lane. Over 20 MB, or a video, it is
  converted with ffmpeg into ten-minute 16 kHz parts, transcribed in order
  and stitched (segment times shifted); at most four hours per call. Only
  real audio/video containers are opened (never a playlist naming other
  files). Offered when a transcription engine is bound.
- `speak({ text, voice?, output_path? })` — the Speech lane reads up to 5000
  characters; the audio is saved in the workspace (default
  `.octipus/media/speech/<id>.mp3`; an `output_path` must be a new file and,
  in a space, not a coding agent's configuration) and its path returned.
  Offered when a speech engine is bound.

Screenshots (`browser__screenshot`, `browser-ext__screenshot`) and images an
MCP server returns are saved in the workspace (`.octipus/media/…`) and shown
the same way: pixels for a model that is shown images, the path for one that
is not. Base64 never goes into the conversation. In a space a member's
screenshot is not filed in the shared workspace: it is returned as before.

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
| `media.audioInput` | `transcribe` | `native`: a model that hears audio also gets the recording itself (WAV/MP3). |
| `media.replayRecentImages` | 3 | How many image-bearing messages keep their pixels. |
| `media.fileChannelImages` | off | Also file images sent alone on a channel as documents. |
