# Chat Revamp Plan — Editor-Style Interface

**Goal**: Transform the current basic chat into a polished, editor-style interface inspired by OpenCode, with file upload, voice integration, better session handling, and a more capable input system.

**Reference**: [OpenCode](https://github.com/anomalyco/opencode) — SolidJS-based AI coding editor with headless server, TUI, web, and desktop clients.

---

## Current State Assessment

### What We Have
- Multi-session chat with tab-based switching
- WebSocket real-time communication with REST fallback
- Agent activity tracking (orchestrator events, worker spawning)
- Preset/expert agent selection
- Model selector
- Token usage stats
- Basic browser Speech Recognition (Web Speech API) in chat input — toggle button, interim results
- Full backend voice stack: STT (Whisper, FasterWhisper), TTS (Piper, EdgeTTS, Coqui), Wake Word (Sherpa, Porcupine)
- Backend attachment type definitions (image, file, audio, video) + WebChat channel supports attachments
- Permission/approval request handling

### What's Missing
- No file upload UI (backend supports it, frontend doesn't)
- No TTS playback in chat (backend supports it, frontend doesn't)
- No voice recording indicator/waveform
- No file references in messages (`@file` syntax)
- No inline code/diff display in messages
- No command palette or slash commands
- No session search/history browser
- No context window usage indicator
- No prompt history (up/down arrow)
- No external editor support
- No drag-and-drop file attachment

---

## Phase 0: Fix Existing Issues (Pre-requisite)

### 0.1 Merge Tools & Permissions Page
The current Tools page separates "tools" and "permissions" per module which is confusing. Merge into a single "Tools & Permissions" view:
- Each tool module card shows its functions with inline permission controls
- Remove the separate Permissions/Tools sections inside each card
- Single expandable card per module: name, description, status, then a flat list of capabilities with ALLOW/ASK/DENY toggles
- Remove the `/permissions` redirect page entirely

### 0.2 Fix Skills Page
- Ensure Skills page (`/skills`) fetches from `/api/skills` and displays domain knowledge (principles, best practices, anti-patterns)
- Clean up any remaining "Skills & Tools" confusion in titles

**Files**: `web/app/tools/page.tsx`, `web/app/skills/page.tsx`, `web/app/permissions/page.tsx`

**Verification**: Both pages render correctly with distinct content after `assistant restart`

---

## Phase 1: Chat Layout Revamp

### 1.1 Editor-Style Layout
Replace the current simple chat layout with a panel-based editor layout:

```
+------------------+------------------------+------------------+
|    Session List   |     Message Timeline   |   Side Panel     |
|    (left panel)   |     (center, main)     |   (right panel)  |
|                   |                        |                  |
|  - Search         |  [messages scroll]     |  - Session Info   |
|  - Session groups |                        |  - Agent Activity |
|  - Active status  |                        |  - Token Usage    |
|  - Date grouping  |                        |  - Files Changed  |
|                   |                        |  - Cost Tracking  |
|                   +------------------------+                  |
|                   |    Prompt Input Area   |                  |
|                   |  [attachments bar]     |                  |
|                   |  [textarea + controls] |                  |
+------------------+------------------------+------------------+
```

- **Left panel**: Session list with search, date grouping ("Today", "Yesterday", "This Week"), active session indicator, create/rename/delete
- **Center**: Message timeline (scrollable) + prompt input area (bottom)
- **Right panel** (collapsible): Session stats, agent activity, token/cost tracking, files touched

### 1.2 Session Management Improvements
- Session search/filter
- Session grouping by date
- Session renaming inline (double-click or edit icon)
- Session delete with confirmation
- Show token count / cost per session in list
- Active/working indicator (spinner for busy sessions)
- Persist last active session across page reloads

### 1.3 Message Timeline Enhancements
- Render tool calls inline with collapsible details
- Syntax-highlighted code blocks with copy button
- Diff display for file changes (red/green like git diff)
- Collapsible thinking/reasoning blocks
- Timestamp display (toggle)
- Message grouping by turn (user message + all assistant responses)
- Scroll-to-bottom button when not at bottom
- Lazy-load older messages on scroll up

**Files to create/modify**:
- `web/components/chat/session-list.tsx` (new — replaces tab-based switching)
- `web/components/chat/message-timeline.tsx` (new — replaces inline message rendering)
- `web/components/chat/side-panel.tsx` (new)
- `web/components/chat/chat-layout.tsx` (new — orchestrates panels)
- `web/app/chat/page.tsx` (rewrite)

**Verification**: Three-panel layout renders, sessions switchable from left panel, right panel shows stats

---

## Phase 2: Enhanced Prompt Input

### 2.1 Rich Prompt Input
- Multi-line textarea with auto-resize
- `@` file mention with fuzzy autocomplete (searches project files via API)
- `/` slash commands (e.g., `/clear`, `/expert`, `/model`, `/help`)
- Prompt history (up/down arrow to navigate previous messages)
- Shift+Enter for newlines, Enter to send (configurable)
- Character/token count indicator

### 2.2 Attachment Bar
- Visual bar above the textarea showing attached files/images
- Each attachment: thumbnail/icon + filename + remove button
- Drag-and-drop zone (full chat area)
- Click-to-attach button (file picker)
- Paste image from clipboard (Ctrl+V)
- Accepted types: images (png, jpg, gif, webp), text files, code files, audio files
- Max file size indicator

### 2.3 Expert/Model Quick Switcher
- Compact expert selector in the input area (current expert shown as badge)
- Model selector as dropdown in input area
- Keyboard shortcut to switch (e.g., Tab like OpenCode)

**Files to create/modify**:
- `web/components/chat/prompt-input.tsx` (new — replaces `chat-input.tsx`)
- `web/components/chat/file-autocomplete.tsx` (new)
- `web/components/chat/slash-commands.tsx` (new)
- `web/components/chat/attachment-bar.tsx` (new)

**API additions needed**:
- `GET /api/files/search?q=...` — fuzzy file search for `@` mentions
- `POST /api/chat/upload` — file upload endpoint (returns attachment ID)

**Verification**: Can type `@` and see file suggestions, can drag files onto chat, attachments shown in bar

---

## Phase 3: File Upload & Processing

### 3.1 Upload Pipeline
- Frontend: File input + drag-and-drop + clipboard paste
- Upload to backend via multipart form POST
- Backend stores in temp dir, returns attachment metadata
- Attachments sent with chat message via WebSocket/REST
- Images: include as vision content in LLM messages
- Text/code files: include content as context
- Audio files: auto-transcribe via STT, include transcript

### 3.2 Attachment Display in Messages
- Images: inline preview (click to enlarge)
- Code files: syntax-highlighted collapsible block
- Audio: mini player with waveform
- Generic files: icon + filename + size

### 3.3 Backend Changes
- `POST /api/upload` — multipart file upload, stores to `data/uploads/`, returns `{ id, filename, mimeType, size, url }`
- Modify WebSocket message handler to accept attachment IDs
- Modify orchestrator to include attachments in LLM context
- Auto-transcribe audio attachments before sending to LLM
- Clean up old uploads periodically

**Files to create/modify**:
- `src/api/routes/upload.ts` (new)
- `web/components/chat/attachment-preview.tsx` (new)
- `web/components/chat/image-lightbox.tsx` (new)
- `src/channels/webchat/index.ts` (modify — handle attachments)

**Verification**: Upload image → see preview in message → LLM can "see" the image. Upload audio → auto-transcribed → shown as text.

---

## Phase 4: Voice Integration in Chat

### 4.1 Voice Input (STT)
- Microphone button in prompt input area
- Press-and-hold or toggle recording mode
- Real-time waveform/level indicator while recording
- Send audio to backend `/api/voice/transcribe`
- Transcribed text inserted into prompt input
- Option to send immediately after transcription
- Fallback to Web Speech API if backend STT unavailable

### 4.2 Voice Output (TTS)
- "Read aloud" button on assistant messages
- Uses backend TTS endpoint to generate audio
- Mini audio player inline or floating
- Auto-read mode toggle (automatically reads new responses)
- Voice/speed settings in chat preferences

### 4.3 Voice Status
- Indicator showing STT/TTS availability
- Settings panel for voice preferences (engine, language, voice, speed)

**API additions needed**:
- `POST /api/voice/synthesize` — TTS endpoint (text → audio blob)
- `GET /api/voice/voices` — list available voices

**Files to create/modify**:
- `web/components/chat/voice-recorder.tsx` (new — replaces inline speech recognition)
- `web/components/chat/voice-player.tsx` (new — TTS playback)
- `web/components/chat/voice-settings.tsx` (new)
- `src/api/routes/voice.ts` (modify — add synthesize endpoint)

**Verification**: Click mic → see waveform → release → text appears in input. Click speaker on message → hear it read aloud.

---

## Phase 5: Polish & Quality

### 5.1 Keyboard Shortcuts
- `Ctrl+K`: Command palette
- `Ctrl+N`: New session
- `Ctrl+W`: Close session
- `Ctrl+Up/Down`: Navigate sessions
- `Up` (empty input): Previous prompt
- `Escape`: Cancel recording / close panels
- `Ctrl+Shift+V`: Paste as file attachment

### 5.2 Responsive Design
- Mobile: Single panel with bottom sheet for sessions
- Tablet: Two panels (session list + chat)
- Desktop: Full three-panel layout

### 5.3 Themes & Preferences
- Chat-specific settings (font size, message density, timestamp format)
- Code block theme selection
- Persist preferences in localStorage

### 5.4 Performance
- Virtualized message list for long sessions
- Lazy-load session messages
- Debounced file search
- WebSocket reconnection with exponential backoff

**Verification**: All shortcuts work, responsive at all breakpoints, smooth scrolling with 100+ messages

---

## Implementation Priority

| Priority | Phase | Effort | Impact |
|----------|-------|--------|--------|
| 1 | Phase 0 — Fix Tools/Skills pages | Small | Unblocks current broken UI |
| 2 | Phase 1.1 — Editor layout | Medium | Foundation for everything else |
| 3 | Phase 2.1-2.2 — Rich input + attachments | Medium | Core UX improvement |
| 4 | Phase 3 — File upload pipeline | Medium | Key missing feature |
| 5 | Phase 4.1 — Voice input | Small | Backend exists, just UI wiring |
| 6 | Phase 1.2-1.3 — Session + timeline polish | Medium | Quality improvement |
| 7 | Phase 4.2 — Voice output | Small | Nice-to-have |
| 8 | Phase 5 — Polish | Medium | Professional feel |

---

## Anti-Patterns to Avoid

- Don't over-abstract UI components before the layout is stable
- Don't build a plugin system — keep it integrated
- Don't try to replicate OpenCode's TUI — focus on the web UI
- Don't build custom rich text editor — use contenteditable sparingly, prefer textarea + overlay
- Don't stream file uploads through WebSocket — use HTTP multipart
- Don't store uploads in database — use filesystem with metadata in DB
- Don't implement @file references as tokens in a custom parser — use simple regex + overlay rendering

---

## Dependencies

- **shadcn/ui** or current component library for consistent styling
- **react-virtuoso** or similar for virtualized message list
- **prismjs** or **shiki** for syntax highlighting (if not already present)
- **wavesurfer.js** for audio waveform display
- Current backend voice stack (already implemented)
- Current WebSocket infrastructure (already implemented)
