# Octipus companion studies

The [identity guide](IDENTITY.md) records the audience, promise, values, voice,
visual language, and website application: **Make it yours. Work together.**

The starting direction is **Pebble**: an SVG octopus with eight short arms,
readable eyes, sea-glass color, and expressive motion. Open
[the companion lab](companion-lab.html) in a browser to compare Pebble, Ribbon,
and Inky, choose colors, and try the motion studies. It is a standalone prototype;
the shared chat and its small project sketch are illustrative.

The second motion study increases the movement and distinguishes the states:
idle explores left, right, and up; listening leans and nods; working moves arms
in sequence; an idea raises an arm; completion bounces; interruption settles.
The lab's names and colors are temporary preview choices, not saved settings.

## First application integration

`web/components/companion/companion-avatar.tsx` and its CSS implement Pebble at
36px in the web chat timeline, with a 64px empty-state version. The live companion
at the bottom follows the current turn and the existing voice-listening state.
Stored transcript avatars remain still. Newly delivered private-chat replies get
a short arrival gesture; this means a reply arrived, not that its claims were
independently verified. A budget refusal uses the interrupted expression.

Private chat uses the existing `/persona` name. Pending permissions and approvals
retain their session IDs so another conversation's request cannot put this
companion into its waiting pose. Unknown-session requests remain available in
the permission banner without being attributed to a conversation. A disconnected
gateway stops working motion and labels the activity as potentially out of date.

The shared-room timeline reuses Pebble and respects the room connection state.
Local rooms now use personal owner/name attribution and custom-name mentions,
as described below.
Saved appearance is described below. There is no inferred "idea" event yet.

The motion toggle pauses companion animation for the mounted timeline. System
reduced-motion preferences disable animation in CSS while preserving text status.
The styles and keyframes are namespaced and require no animation library.

## Validation

`tests/web/companion.spec.ts` exercises the production web bundle with gateway
and API fixtures: live work, session-scoped permissions, reply arrival, disconnects,
pending snapshots, manual pause, reduced motion, and mobile sizing. Existing chat,
chat-delivery, permission-sync, and room tests cover the shared surfaces. These
checks verify UI event handling rather than real-provider output quality.

## Personal companion attribution in rooms

Local shared rooms now complete the requester's companion name and use it in the
Ask toggle. Selecting a companion is an explicit Ask action; the authenticated
user ID determines execution. A name matching a member stays a member mention
unless the Ask toggle is enabled. The server snapshots public companion and
owner names on addressed posts and completed replies; past replies retain those
names after a rename. The live turn strip carries the post's companion identity.
Remote-hosted rooms retain their existing host-agent addressing.

## Saved appearance

The Persona page offers Pebble, Ribbon, and Inky in five colors, with a 180px
animated preview. Draft choices remain local until saved through
`PUT /api/persona/appearance`. The existing assistant profile stores one
`appearance` fact; the resolver exposes its validated public shape/color without
adding it to the prompt. Persona reset restores Pebble in Sea glass.

Private chat uses the current appearance. New shared-room posts and final replies
snapshot it with the public companion identity; older rows keep the default
appearance. SVG geometry comes from the concept studies, with the same animation
classes and reduced-motion behavior as Pebble.

Browser coverage includes save/reload, private chat, shared-room snapshots, failed
saves, discard, mobile sizing, and reduced motion. Database/API coverage verifies
per-user isolation, validation, reset, and historical appearance snapshots.

Cross-owner requests remain separate follow-up work.

## Shared brainstorm experience

Room members see the active companion with its owner and saved appearance,
including when it is waiting for the requester’s approval. Disconnection changes
that status instead of claiming work is still live. Explicit public progress
messages retain the queued companion identity and survive reload; private tool
activity and streaming answer text keep their existing requester-only visibility.

The Work panel indexes interactive outputs, recent public updates, and completed
replies from loaded room history. It returns the reader to the original message,
closing the overlay on mobile. Earlier history can be loaded from the panel.
Interactive output execution still needs the existing Run action.

Explore ideas, Research, Prototype, and Next steps append editable prompts and
enable Ask. They preserve existing draft text and never submit automatically.
These are ways to start real work, not simulated research or progress events.

Room browser coverage verifies two members with different companions, drafts,
public work and approval states, persisted attribution, interactive output indexing,
reloads, and mobile navigation. Backend integration coverage verifies that only
the active requester can publish progress and that authorized room subscribers
receive the same attributed update as reloaded history.

## App identity alignment

The web app uses the same still sea-glass product mark as the website, with
personal companion appearances reserved for the user's work and Persona settings.
Shared page headings use readable titles, cards have softer corners, and room
controls use Manrope. Code, paths, execution details, and dense technical views
retain monospace where it helps reading.

The dashboard begins with the user's companion and links into chat, research,
tasks, and Persona. A shared or remote workspace also offers Work together.
Operational statistics remain below. The Persona preview uses the website's warm
paper surface and allows gentle mouse-following eyes only while idle and animated.
Pausing motion, reduced motion, and changing to a work state disable that gaze.
Transcript avatars and live activity do not follow the pointer.

Browser checks cover the welcome actions, personal appearance, mobile sizing,
pointer tracking, pause and reduced motion, shared rooms, and accessibility.

## Moving between work surfaces

The dashboard puts recent conversations before operational statistics and opens
an individual conversation directly. Failed history requests show a retry rather
than an empty-history message. Work pages share a compact navigation row for
conversations, research, documents, prototypes and apps, and next steps. Shared
workspaces also offer rooms; remote workspaces offer only rooms and next steps
because these destinations support the remote workspace data source.

Research addresses retain the job ID, so a reload or bookmarked return checks
the same investigation. During the current app session the navigation remembers
that address for the signed-in user. Research remains personal and says so in
shared contexts. Navigation never copies private content into a shared room.
The room Work panel links to the task board for agreed follow-ups while continuing
to index only that room’s loaded conversation.
