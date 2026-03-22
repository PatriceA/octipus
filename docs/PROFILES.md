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
| `category` | string | Entity type: `person`, `organization`, `pet` |
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

## Agent Tools

Agents with the `profiles` tool (available to orchestrator, research, communication, general roles) can:

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
Name: Patrice
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
| `/api/tools/profiles/tools/add_fact/execute` | POST | Add fact to profile |

## Database

Table: `profiles` (migration: `0017_profiles.sql`)

Indexes: `user_id`, `name`

## Key Files

| File | Purpose |
|------|---------|
| `src/db/schema/profiles.ts` | Database schema |
| `src/db/repositories/profile-repository.ts` | Repository with CRUD + search |
| `src/tools/profiles/index.ts` | Agent tool (8 sub-tools) |
| `src/core/orchestrator/worker-spawner.ts` | User profile injection into prompts |
