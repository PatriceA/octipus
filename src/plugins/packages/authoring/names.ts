/**
 * The creator-mode tools (src/tools/plugin-dev), named once so the tool, the
 * contract (./contract.ts) and the skill (./skill.ts) agree. Dependency-free.
 */
export const PLUGIN_DEV_TOOL_ID = 'plugin_dev';

export const PLUGIN_DEV_TOOLS = {
  api: 'plugin_api',
  template: 'plugin_template',
  validate: 'plugin_validate',
  install: 'plugin_install',
} as const;

/** How an agent calls one of them: `<container>__<tool>`. */
export function pluginDevToolName(tool: keyof typeof PLUGIN_DEV_TOOLS): string {
  return `${PLUGIN_DEV_TOOL_ID}__${PLUGIN_DEV_TOOLS[tool]}`;
}
