/**
 * Built-in skill tools (`list_skills` / `get_skill` / `update_skill`).
 *
 * Worker prompts carry only a skill *index* (name + 1-line description); the
 * full SKILL.md body is loaded on demand. That on-demand step previously
 * existed ONLY as the `octipus_get_skill` MCP-server tool — so a role without
 * `mcp` in its allowlist (qa, review, communication, design, pm, finance) got a
 * skill index that referenced a tool it couldn't call. These built-in handlers
 * close that gap: registered globally (see src/index.ts), every spawned worker
 * can load skill content regardless of role or MCP availability.
 *
 * No `toolId` — like `spawn_child`, these are framework meta-tools that stay in
 * the advertised set even under lazy tool discovery.
 */

import type { ToolHandler } from '@/core/agent-base';
import { getSkillRegistry } from '@/skills/registry';
import { buildSkillResourceHandlers } from './skill-runtime';
import { updateSkill } from '@/skills/update';

export function buildSkillLoaderHandlers(): ToolHandler[] {
  return [
    ...buildSkillResourceHandlers(),
    {
      name: 'update_skill',
      description: 'Update an existing Octipus skill in place. Read it with get_skill first, then send only changed fields. Content replaces the full Markdown body; empty content switches to structured fields. Keeps the skill ID and role assignments. Mounted skills must be edited at their source and reloaded.',
      parameters: {
        type: 'object',
        properties: {
          skill_id: { type: 'string', description: 'Existing skill ID from list_skills.' },
          name: { type: 'string' }, description: { type: 'string' }, category: { type: 'string' },
          content: { type: 'string', description: 'Complete replacement Markdown, not a diff.' },
          principles: { type: 'array', items: { type: 'string' } },
          bestPractices: { type: 'array', items: { type: 'string' } },
          antiPatterns: { type: 'array', items: { type: 'string' } },
          frameworks: { type: 'array', items: { type: 'string' } },
        },
        required: ['skill_id'],
      },
      execute: async (args, context) => {
        const { skill_id, ...fields } = args;
        return updateSkill(skill_id, fields, context.userId);
      },
    },
    {
      name: 'list_skills',
      description:
        'List the skills available to load (id + name + 1-line description). ' +
        'Call get_skill with an id to load a skill\'s full instructions before applying it.',
      parameters: {
        type: 'object',
        properties: {},
      },
      execute: async (_args, context) => {
        const skills = await getSkillRegistry().getAll(context.userId);
        return skills.map((s) => ({
          id: s.id,
          name: s.name,
          description: (s.description || '').replace(/\s+/g, ' ').trim().slice(0, 200),
        }));
      },
    },
    {
      name: 'get_skill',
      description:
        'Load the full content of a skill by id (from the skills index in your prompt, or from list_skills). ' +
        'Returns the skill\'s instructions/spec to follow.',
      parameters: {
        type: 'object',
        properties: {
          skill_id: {
            type: 'string',
            description: 'The skill id to load (e.g. from the skills index or list_skills).',
          },
        },
        required: ['skill_id'],
      },
      execute: async (args, context) => {
        const skillId = args.skill_id;
        if (typeof skillId !== 'string') {
          throw new Error("get_skill: 'skill_id' must be a string.");
        }
        const rendered = await getSkillRegistry().renderSkill(skillId, context.userId);
        if (rendered === null) {
          throw new Error(`Unknown skill '${skillId}'. Call list_skills to see available ids.`);
        }
        return rendered;
      },
    },
  ];
}
