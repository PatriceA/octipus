# People & Profiles

Store and recall information about people, organizations, and relationships. Facts accumulate over time as agents learn new information from conversations.

## Overview

The profiles system gives agents persistent memory about the people in the user's life. When a user says "my mother lives in Berlin" or "my boss prefers email over Slack", that information is stored and available to all future agent interactions.

The user's own profile (marked with `isUserProfile: true`) is automatically injected into every agent's system prompt, providing personalized context without the user having to repeat themselves.

## Schema

Each profile has:

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Display name ("Mom", "Dr. Mueller", "Acme Corp") |
| `relationship` | string | Relation to user ("self", "mother", "colleague", "boss", "friend") |
| `category` | string | Entity type: `person`, `organization`, `pet`, `assistant` |
| `facts` | array | Key-value facts with source and timestamp |
| `isUserProfile` | boolean | If true, facts are injected into agent system prompts |

### Facts Structure

```json
{
  "key": "location",
  "value": "Berlin, Germany",
  "source": "user told us",
  "learnedAt": "2026-03-22T18:00:00Z"
}
```

Common fact keys: `location`, `birthday`, `email`, `phone`, `likes`, `dislikes`, `occupation`, `timezone`, `language`, `notes`.

### Assistant Profile (Persona)

A special profile row with `category='assistant'` stores the root agent's per-user persona. Exactly one per user. Its `name` is what the root agent calls itself ("Octipus" by default, or whatever the user renamed it to via `/persona name <X>`). Fact keys for this category:

| Key | Value |
|-----|-------|
| `preset_id` | Which YAML preset under `personas/` seeded this profile (`octipus`, `mentor`, …) |
| `pronouns` | Rendered into the persona prompt (default `it/we`) |
| `tone` | One of `dry|playful|neutral|professional|terse|verbose` |
| `narration` | Live swarm narration volume: `off|minimal|chatty` |
| `appearance` | Saved companion shape and color (JSON; presentation only) |
| `extra:N` | Free-form rules added via `/persona say` or the web UI |

Auto-created on first edit. See [CHAT-COMMANDS.md](CHAT-COMMANDS.md#persona) for the slash commands and the [UX revamp plan](plans/ux-personality-revamp.md) for the full design.

### Companion appearance

Open **Persona → Your companion’s look** to choose Pebble, Ribbon, or Inky,
then a color: Sea glass, Coral, Lavender, Sunshine, or Ocean blue. The animated
preview lets you try looking around, listening, working, and waiting. Changes
stay in the preview until **Save appearance** succeeds; **Discard changes**
restores the saved choice. You can pause the preview, and system reduced-motion
preferences apply.

The appearance is saved per user and follows their companion in private chat
and new shared-room replies. Room replies keep an appearance snapshot alongside
their name and owner, so a later change does not restyle history. Older room
replies use Pebble in Sea glass. The full persona reset also resets appearance;
switching a personality preset keeps it.

`GET /api/persona` includes `appearance`. `PUT /api/persona/appearance` accepts
`{ "form": "ribbon", "color": "coral" }` for the authenticated user only. Forms
are `pebble|ribbon|ink`; colors are `sea-glass|coral|lavender|sunshine|blue`.
Unknown values and extra fields are rejected. Appearance is presentation data,
not a persona instruction or an additional permission.

### Companion names in shared rooms

In rooms hosted by your installation, type `@Sparkle` after naming your companion
Sparkle, or select **your companion** from `@` autocomplete. Selecting it turns on
**Ask Sparkle**; the toggle also works without a mention. `@octipus` remains an
alias for your own companion.

Each person invokes their own companion. Execution uses the authenticated
requester's user ID, permissions and funding, even when two companions share a
name. A plain mention matching a space member's username addresses that member;
choose **your companion** or use the Ask toggle to disambiguate.

New completed replies and public progress updates show **Sparkle · Alex’s companion**.
The server stores the owner ID, display names, and appearance with these messages, so a later rename does not rewrite
history. Only public names are exposed; persona instructions and personal facts
are not included in room attribution. Older replies keep their generic Octipus
label. Rooms hosted by another installation retain their existing host-agent
addressing.

## Agent Tools

Agents with the `profiles` tool (available to root agent, research, communication, general roles) can:

| Tool | Description |
|------|-------------|
| `list_profiles` | List all profiles for the current user |
| `get_profile` | Get a profile by ID or name |
| `create_profile` | Create a new profile |
| `update_profile` | Update profile fields |
| `add_fact` | Add or update a fact on a profile |
| `remove_fact` | Remove a fact by key |
| `delete_profile` | Delete a profile |
| `search_profiles` | Search profiles by name or fact values |

## User Profile Injection

When a user has a profile with `isUserProfile: true` and at least one fact, those facts are appended to every worker agent's system prompt:

```
USER CONTEXT:
Name: Max
- location: Berlin, Germany
- timezone: Europe/Berlin
- language: English, German
```

This means agents automatically know the user's location for weather queries, their timezone for scheduling, their language preferences, etc.

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/tools/profiles/tools/list_profiles/execute` | POST | List profiles |
| `/api/tools/profiles/tools/get_profile/execute` | POST | Get profile by ID/name |
| `/api/tools/profiles/tools/create_profile/execute` | POST | Create profile |
| `/api/tools/profiles/tools/update_profile/execute` | POST | Update profile fields |
| `/api/tools/profiles/tools/add_fact/execute` | POST | Add fact to profile |
| `/api/tools/profiles/tools/remove_fact/execute` | POST | Remove a fact |
| `/api/tools/profiles/tools/delete_profile/execute` | POST | Delete profile |
| `/api/tools/profiles/tools/search_profiles/execute` | POST | Search profiles |

## Database

Table: `profiles` (migration: `0017_profiles.sql`)

Indexes: `user_id`, `name`

## Key Files

| File | Purpose |
|------|---------|
| `src/db/schema/profiles.ts` | Database schema |
| `src/db/repositories/profile-repository.ts` | Repository with CRUD + search |
| `src/tools/profiles/index.ts` | Agent tool (8 sub-tools) |
| `src/core/agent/worker-spawner.ts` | User profile injection into prompts |
