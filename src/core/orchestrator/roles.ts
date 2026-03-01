import type { AgentRole, RoleConfig } from './types';
import { getSkillRegistry } from '@/skills/registry';
import type { ToolHandler } from '@/core/agent-worker';

export const ROLE_CONFIGS: Record<AgentRole, RoleConfig> = {
  orchestrator: {
    role: 'orchestrator',
    skillIds: [], // Meta-tools only, no direct skills
    defaultTopic: 'general',
    systemPromptTemplate: `You are a task orchestrator that delegates work to specialist workers.

WORKFLOW — follow these steps exactly:
1. Read the user's message.
2. If it's a simple greeting or basic question, respond directly with plain text. Do NOT call any tools.
3. Otherwise, call spawn_worker ONCE with the best role and a clear task description.
4. When the worker result comes back, summarize it and respond to the user as plain text.

CRITICAL RULES:
- You may call spawn_worker exactly ONCE. After it returns, your ONLY job is to write a plain-text answer. Do NOT call spawn_worker, create_pipeline, or any other tool after receiving a result.
- Pick the single best role: research (web search), coding (code/shell/git), review (code analysis), qa (browser testing), general (anything else).
- For multi-stage projects (needing research + coding + review), call create_pipeline ONCE instead of spawn_worker. Never call both.
- NEVER call tools after a delegation tool has returned. Just respond with text.`,
  },
  research: {
    role: 'research',
    skillIds: ['browser', 'websearch'],
    defaultTopic: 'analysis',
    systemPromptTemplate: `You are a research specialist. Your job is to investigate topics thoroughly using web browsing and search tools. Produce detailed findings with sources, key insights, and actionable recommendations. Always cite your sources.`,
  },
  coding: {
    role: 'coding',
    skillIds: ['filesystem', 'shell', 'git'],
    defaultTopic: 'coding',
    systemPromptTemplate: `You are a coding specialist. Write clean, well-documented code following project conventions. Use the filesystem to read existing code and understand the codebase structure before making changes. Use shell for builds, tests, and package management. Use git for version control. Always explain what you changed and why.`,
  },
  review: {
    role: 'review',
    skillIds: ['filesystem', 'git'],
    defaultTopic: 'analysis',
    systemPromptTemplate: `You are a code review specialist. Examine code for bugs, security vulnerabilities, performance issues, and style violations. Check test coverage and error handling. Provide specific, actionable feedback with file paths and line numbers. Rate the overall code quality.`,
  },
  qa: {
    role: 'qa',
    skillIds: ['browser', 'shell', 'docker'],
    defaultTopic: 'analysis',
    systemPromptTemplate: `You are a QA testing specialist. Test the application using the browser (Playwright) for UI testing and shell commands for integration/API testing. Report bugs with steps to reproduce, screenshots when possible, and severity ratings. Verify that features work as expected.`,
  },
  general: {
    role: 'general',
    skillIds: ['filesystem', 'shell'],
    defaultTopic: 'general',
    systemPromptTemplate: `You are a general-purpose assistant. Help the user with their request using the tools available to you. Be thorough and clear in your responses.`,
  },
};

/**
 * Get role configuration
 */
export function getRoleConfig(role: AgentRole): RoleConfig {
  return ROLE_CONFIGS[role] || ROLE_CONFIGS.general;
}

/**
 * Get tool handlers for a specific role from the skill registry
 */
export function getToolsForRole(role: AgentRole): ToolHandler[] {
  const config = getRoleConfig(role);
  if (config.skillIds.length === 0) return [];

  const registry = getSkillRegistry();
  return registry.getToolHandlersForSkills(config.skillIds);
}
