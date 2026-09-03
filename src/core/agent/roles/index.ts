/**
 * Role registry — one entry per `roles/<name>/` folder.
 *
 * Each role is a folder containing:
 *   - `config.ts`       — exports `meta: RoleMeta` (role, toolIds, defaultTopic)
 *   - `prompt.md`       — system prompt template
 *   - `prompt.lite.md`  — dense variant for small models
 *
 * Adding a role is two files in the folder plus three lines here.
 *
 * The three lines are the point. This used to scan the directory at runtime and
 * `require()` each `config.ts`, which worked only because the previous runtime
 * executed TypeScript from source: in the bundled artifact `import.meta.url`
 * resolves inside `dist/`, the scan found no folders, and every role came back
 * undefined — the orchestrator failed its first turn with "Cannot read
 * properties of undefined (reading 'systemPromptTemplate')". Static imports are
 * what a bundler can see, and a missing role is now a compile error rather than
 * an empty registry at runtime.
 */

import type { AgentRole, RoleConfig } from '../types';
import type { RoleMeta } from './types';

import { meta as aiMeta } from './ai/config';
import aiPrompt from './ai/prompt.md';
import aiLitePrompt from './ai/prompt.lite.md';
import { meta as architectureMeta } from './architecture/config';
import architecturePrompt from './architecture/prompt.md';
import architectureLitePrompt from './architecture/prompt.lite.md';
import { meta as automationMeta } from './automation/config';
import automationPrompt from './automation/prompt.md';
import automationLitePrompt from './automation/prompt.lite.md';
import { meta as codingMeta } from './coding/config';
import codingPrompt from './coding/prompt.md';
import codingLitePrompt from './coding/prompt.lite.md';
import { meta as communicationMeta } from './communication/config';
import communicationPrompt from './communication/prompt.md';
import communicationLitePrompt from './communication/prompt.lite.md';
import { meta as dataMeta } from './data/config';
import dataPrompt from './data/prompt.md';
import dataLitePrompt from './data/prompt.lite.md';
import { meta as designMeta } from './design/config';
import designPrompt from './design/prompt.md';
import designLitePrompt from './design/prompt.lite.md';
import { meta as devopsMeta } from './devops/config';
import devopsPrompt from './devops/prompt.md';
import devopsLitePrompt from './devops/prompt.lite.md';
import { meta as financeMeta } from './finance/config';
import financePrompt from './finance/prompt.md';
import financeLitePrompt from './finance/prompt.lite.md';
import { meta as generalMeta } from './general/config';
import generalPrompt from './general/prompt.md';
import generalLitePrompt from './general/prompt.lite.md';
import { meta as pmMeta } from './pm/config';
import pmPrompt from './pm/prompt.md';
import pmLitePrompt from './pm/prompt.lite.md';
import { meta as qaMeta } from './qa/config';
import qaPrompt from './qa/prompt.md';
import qaLitePrompt from './qa/prompt.lite.md';
import { meta as researchMeta } from './research/config';
import researchPrompt from './research/prompt.md';
import researchLitePrompt from './research/prompt.lite.md';
import { meta as reviewMeta } from './review/config';
import reviewPrompt from './review/prompt.md';
import reviewLitePrompt from './review/prompt.lite.md';
import { meta as securityMeta } from './security/config';
import securityPrompt from './security/prompt.md';
import securityLitePrompt from './security/prompt.lite.md';
import { meta as writingMeta } from './writing/config';
import writingPrompt from './writing/prompt.md';
import writingLitePrompt from './writing/prompt.lite.md';

interface RoleSource {
  meta: RoleMeta;
  prompt: string;
  litePrompt: string;
}

const SOURCES: RoleSource[] = [
  { meta: aiMeta, prompt: aiPrompt, litePrompt: aiLitePrompt },
  { meta: architectureMeta, prompt: architecturePrompt, litePrompt: architectureLitePrompt },
  { meta: automationMeta, prompt: automationPrompt, litePrompt: automationLitePrompt },
  { meta: codingMeta, prompt: codingPrompt, litePrompt: codingLitePrompt },
  { meta: communicationMeta, prompt: communicationPrompt, litePrompt: communicationLitePrompt },
  { meta: dataMeta, prompt: dataPrompt, litePrompt: dataLitePrompt },
  { meta: designMeta, prompt: designPrompt, litePrompt: designLitePrompt },
  { meta: devopsMeta, prompt: devopsPrompt, litePrompt: devopsLitePrompt },
  { meta: financeMeta, prompt: financePrompt, litePrompt: financeLitePrompt },
  { meta: generalMeta, prompt: generalPrompt, litePrompt: generalLitePrompt },
  { meta: pmMeta, prompt: pmPrompt, litePrompt: pmLitePrompt },
  { meta: qaMeta, prompt: qaPrompt, litePrompt: qaLitePrompt },
  { meta: researchMeta, prompt: researchPrompt, litePrompt: researchLitePrompt },
  { meta: reviewMeta, prompt: reviewPrompt, litePrompt: reviewLitePrompt },
  { meta: securityMeta, prompt: securityPrompt, litePrompt: securityLitePrompt },
  { meta: writingMeta, prompt: writingPrompt, litePrompt: writingLitePrompt },
];

let cached: Record<AgentRole, RoleConfig> | null = null;

export function loadRoles(): Record<AgentRole, RoleConfig> {
  if (cached) return cached;

  const roles: Partial<Record<AgentRole, RoleConfig>> = {};

  for (const { meta, prompt, litePrompt } of SOURCES) {
    // Invariant: coreToolIds ⊆ toolIds. Fail loud at load — a typo here would
    // silently advertise nothing for that id and force a wasted discovery
    // round-trip on the common path.
    if (meta.coreToolIds) {
      const unknown = meta.coreToolIds.filter((id) => !meta.toolIds.includes(id));
      if (unknown.length > 0) {
        throw new Error(
          `Role '${meta.role}' coreToolIds [${unknown.join(', ')}] not present in toolIds — must be a subset.`,
        );
      }
    }

    if (!prompt.trim()) {
      throw new Error(`Role '${meta.role}' has an empty prompt.md`);
    }

    roles[meta.role] = {
      role: meta.role,
      toolIds: meta.toolIds,
      defaultTopic: meta.defaultTopic,
      systemPromptTemplate: prompt,
      // A blank lite variant is treated as absent so it cannot replace the role
      // prompt with a bare preamble.
      liteSystemPromptTemplate: litePrompt.trim() ? litePrompt : undefined,
      coreToolIds: meta.coreToolIds,
      readOnly: meta.readOnly,
    };
  }

  cached = roles as Record<AgentRole, RoleConfig>;
  return cached;
}

export function reloadRoles(): Record<AgentRole, RoleConfig> {
  cached = null;
  return loadRoles();
}
