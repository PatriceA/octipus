# Octipus identity

## Who it is for

Individuals and small teams who want control over their AI workspace. People
should be able to start alone, make a companion their own, and bring that way
of working into a shared space when collaboration helps.

## Promise

**Make it yours. Work together.**

Supporting line: **Your AI companion. Your shared workspace.**

Octipus gives people a place to turn conversations into research, prototypes,
and next steps using the models and tools they choose. The companion has a
personal name, personality, and appearance. Octipus remains the name of the
product and workspace; a user's companion can be Sparkle, Pip, or another name.

## Values, expressed through the product

| Value | What it means | How people encounter it |
| --- | --- | --- |
| Personal choice | Adapt the companion to the person. | Name, persona instructions, shape, color, model choice. |
| Useful work | Help an idea become something people can inspect and improve. | Research with sources, interactive prototypes, shared replies and next steps. |
| Collaboration | People and their companions contribute in the same space. | Each person invokes their own companion; everyone in the room sees its shared output. |
| Control | Make the workspace and its behavior understandable and configurable. | Self-hosting, open source, model selection, permissions, approval requests, and execution records. |

Private instructions and personal facts are not part of public companion
attribution. Public updates are deliberate shared messages; raw tool activity
and answer deltas are not presented as visible to everyone. Hosting Octipus
locally does not keep data local when a connected external provider receives it.

## Voice

Warm, curious, practical, and candid. Speak as a capable collaborator who is
interested in the person's idea. Use familiar language, concrete verbs, short
sentences, and examples of work. Leave people room to choose.

- Invitation: “What shall we make of it?”
- Personalization: “Give your companion a name and tell it how you like to work.”
- Collaboration: “Your people. Their companions. A shared place to make progress.”
- Action: “Let's make a first version.”
- Control: “Choose your models. Set your permissions.”

Keep personality in invitations, motion, and small moments. Errors, approvals,
and consequential actions need direct language. Avoid claims of effortless
perfection, simulated live research, guarantees of privacy across providers, or
suggestions that a cheerful expression means an answer is correct.

## Visual language

Use the existing marine palette: deep ink `#071923`, sea glass `#92c9c5`, and
clear off-white text. A warm paper surface `#f0eee5` gives companion previews a
welcoming contrast. Coral `#efa99b`, lavender `#b7a6e8`, sunshine `#e9c776`, and
ocean blue `#82b5df` belong to the same companion family.

Manrope is the website's humanist sans. Use generous spacing, readable copy,
soft corners, and fine borders. Put actual work in recognizable conversation
and output surfaces. Use the approved natural Blender portraits for personal companions. Keep the minimal mobile app mark as the product logo.
The product mark is the white line octopus on deep ink; personal companions can vary.

## Motion

Natural portraits stay still. Working and listening may show a gentle activity
ring. Status comes from labels and execution records, not facial expressions.
Compact vector status icons can still use their small pose animations.

Use the same forms and animation vocabulary in app and website. Large website
previews make the character readable. A global homepage pause control and system
reduced-motion preference stop decorative animation. Portrait previews do not
track the pointer or animate their anatomy. A quiet desktop depth rail shows
actual reading progress and provides section shortcuts.

The room demonstration plays a finite, labeled script once on entering view.
It offers pause and replay, pauses off-screen or when the page is hidden, and
yields to manual tab or prototype interaction. Reduced motion disables autoplay,
pointer tracking, and decorative transitions; visitors can still step through
the outputs or explicitly play the script. It never pretends to run AI.

## Website application

The homepage follows this order:

1. The promise, a concrete introduction, and an editable companion preview.
2. A labeled shared-room example: research, prototype, next steps.
3. Personal names, personalities, and individual ways of working.
4. Hosting, models, and permissions as tangible expressions of control.
5. An invitation into the actual setup documentation.

Preview names and looks are temporary and local to the page. The demonstration
uses illustrative content, with no model calls or account writes. Capabilities
depend on the configured models, tools, and permissions; the website links to
canonical documentation for setup and behavior.

Website source lives in `/home/patrice/docker-services/octipus-website` on the
current deployment. `src/components/Companion.astro`, `src/data/companion-forms.json`,
and `src/assets/companion.css` mirror the app's SVG geometry and motion. When the
app's companion design changes, update these together. Public docs remain synced
through the repository's website-docs sync script.

## Natural companion artwork (November 2026)

Web and mobile use the same fifteen bundled Blender portraits: Dumbo, Reef and
Inky, each in the five existing account colors. Stable saved IDs remain pebble,
ribbon and ink, so existing preferences and room attribution need no migration.
The web picker is under Persona; the phone picker is in Settings. Phone avatars
share one account-scoped appearance, refreshed at sign-in and foreground return.
Saving on either client uses the existing persona appearance API. Previewing a
look does not save it. Status labels remain independent of the static portrait;
active work may show a gentle ring that respects reduced motion. Small browser
and desktop status glyphs retain the compact vector silhouettes.

Source generation scripts and reproduction instructions are in
[companions/README.md](companions/README.md). Editable Blender scenes and GLBs
are available from https://octipus.cc/design-examples/companions/.
