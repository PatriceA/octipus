import { BaseTool } from '@/tools/base-tool';
import type { ToolManifest } from '@/core/types';

export default class QaDemoTool extends BaseTool {
  readonly id = 'qa-demo';
  readonly name = 'QA Demo';
  readonly version = '0.0.1';
  readonly description = 'Throwaway tool to confirm auto-discovery picks it up.';

  getManifest(): ToolManifest {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      permissions: [],
      tools: [],
    };
  }

  async registerTools() { /* no-op */ }
}
