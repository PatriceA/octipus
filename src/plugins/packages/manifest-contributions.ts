/**
 * The manifest fields of contributions besides tools (docs/PLUGIN-PACKAGES.md#contributions):
 * slash commands, schedules, events, a prompt section and turn context.
 * Merged into the manifest schema (./manifest.ts). Each contribution names
 * one of the package's own declared tools; a reference to a tool it does not
 * declare, a bad cron expression or an unsafe prompt path refuses the install.
 */
import { z } from 'zod';
import { PLUGIN_EVENT_TYPES, PLUGIN_MANIFEST_FILE, type PluginToolEffect } from '@/shared/plugin-package';
import { cronProblem } from './contributions/cron';
import { SIGNATURE_FILE } from './integrity';

/** A command or schedule name: lower-case, digits and -, starting with a letter. */
const SLUG_RE = /^[a-z][a-z0-9-]{0,31}$/;
const ROLE_RE = /^[a-z][a-z0-9_-]{0,49}$/;
const TOOL_REF_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** A relative path inside the package: segments of safe characters, no `.` or `..`, ending in `.md`. */
const PROMPT_FILE_RE = /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*\/){0,8}[A-Za-z0-9_][A-Za-z0-9_.-]*\.md$/;
/** The most a tool `input` template may serialize to. */
export const MAX_CONTRIBUTION_INPUT_CHARS = 4_000;

const inputSchema = z.record(z.string(), z.unknown())
  .refine((v) => JSON.stringify(v).length <= MAX_CONTRIBUTION_INPUT_CHARS, `input: at most ${MAX_CONTRIBUTION_INPUT_CHARS} characters as JSON`);
const rolesSchema = z.array(z.string().regex(ROLE_RE, 'roles: an agent role such as general or researcher'))
  .min(1, 'roles: name at least one role, or leave roles out for every role').max(20, 'roles: at most 20');

/** The contribution fields, spread into the manifest's object schema. */
export const contributionFields = {
  commands: z.array(z.object({
    name: z.string().regex(SLUG_RE, 'commands: a name is lower-case letters, digits and -, starting with a letter (at most 32)'),
    tool: z.string().regex(TOOL_REF_RE),
    description: z.string().trim().min(1).max(200),
    input: inputSchema.optional(),
  }).strict()).max(20).optional(),
  schedules: z.array(z.object({
    id: z.string().regex(SLUG_RE, 'schedules: an id is lower-case letters, digits and -, starting with a letter (at most 32)'),
    cron: z.string().trim().min(9).max(100),
    tool: z.string().regex(TOOL_REF_RE),
    input: inputSchema.optional(),
  }).strict()).max(20).optional(),
  events: z.array(z.object({
    on: z.enum(PLUGIN_EVENT_TYPES, { message: `events: "on" is one of ${PLUGIN_EVENT_TYPES.join(', ')}` }),
    tool: z.string().regex(TOOL_REF_RE),
  }).strict()).max(20).optional(),
  prompt: z.object({
    file: z.string().max(300).regex(PROMPT_FILE_RE, 'prompt: file is a relative path to a .md file inside the package'),
    roles: rolesSchema.optional(),
  }).strict().optional(),
  context: z.object({
    tool: z.string().regex(TOOL_REF_RE),
    roles: rolesSchema.optional(),
  }).strict().optional(),
};

interface ContributionManifest {
  runtime?: string;
  tools?: Record<string, { effect: PluginToolEffect }>;
  commands?: Array<{ name: string; tool: string }>;
  schedules?: Array<{ id: string; cron: string; tool: string }>;
  events?: Array<{ on: string; tool: string }>;
  prompt?: { file: string };
  context?: { tool: string };
}

/**
 * The problems of a manifest's contributions that its shape alone does not
 * show: a tool it does not declare, a context tool that is not a `read`, a
 * name used twice, a bad cron expression, a prompt file the content hash does
 * not cover.
 */
export function contributionProblems(m: ContributionManifest): string[] {
  const problems: string[] = [];
  // Contributions are bound to the plugin's own sandboxed tools; an in-process
  // plugin registers what it adds through octi.* instead.
  if (m.runtime === 'in-process' && (m.commands?.length || m.schedules?.length || m.events?.length || m.prompt || m.context)) {
    problems.push('commands, schedules, events, prompt and context apply to the package runtime only; an in-process plugin registers through octi.*');
  }
  const declared = (where: string, tool: string) => {
    if (!Object.hasOwn(m.tools ?? {}, tool)) problems.push(`${where}: "${tool}" is not one of the package's declared tools`);
  };
  const names = new Set<string>();
  for (const c of m.commands ?? []) {
    declared(`commands.${c.name}`, c.tool);
    if (names.has(c.name)) problems.push(`commands: "${c.name}" is declared twice`);
    names.add(c.name);
  }
  const ids = new Set<string>();
  for (const s of m.schedules ?? []) {
    declared(`schedules.${s.id}`, s.tool);
    if (ids.has(s.id)) problems.push(`schedules: "${s.id}" is declared twice`);
    ids.add(s.id);
    const cron = cronProblem(s.cron);
    if (cron) problems.push(`schedules.${s.id}: cron ${cron}`);
  }
  const pairs = new Set<string>();
  for (const e of m.events ?? []) {
    declared(`events.${e.on}`, e.tool);
    const key = `${e.on}\n${e.tool}`;
    if (pairs.has(key)) problems.push(`events: "${e.on}" → "${e.tool}" is declared twice`);
    pairs.add(key);
  }
  if (m.prompt) {
    const lower = m.prompt.file.toLowerCase();
    if (lower === SIGNATURE_FILE.toLowerCase() || lower === PLUGIN_MANIFEST_FILE.toLowerCase()) {
      problems.push('prompt: file may not be the manifest or the signature file');
    }
  }
  if (m.context) {
    declared('context', m.context.tool);
    // Called before every turn, unattended: only a tool that reads.
    const tool = m.tools?.[m.context.tool];
    if (tool && tool.effect !== 'read') {
      problems.push(`context: "${m.context.tool}" must declare effect "read" (it runs before every turn, with nobody to approve it)`);
    }
  }
  return problems;
}
