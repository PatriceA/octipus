import { CLI_TOOLS, type CLIToolConfig } from '@/models/providers/cli-provider';

/**
 * Check if a provider string indicates a CLI model
 */
export function isCLIProvider(provider: string): boolean {
  return provider === 'cli';
}

/**
 * Get the CLIToolConfig for a given modelId (e.g. 'cli/claude-code', 'cli/gemini')
 */
export function getCLIToolConfig(modelId: string): CLIToolConfig | null {
  return (
    CLI_TOOLS.find((tool) =>
      tool.modelPatterns.some((p) => modelId === p || modelId.startsWith(p + '/'))
    ) || null
  );
}
