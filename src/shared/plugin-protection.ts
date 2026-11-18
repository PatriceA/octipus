/** Owner-managed data access, separate from signed plugin bytes. */
export interface PluginProtectionApproval {
  contentHash: string;
  level: 1 | 2 | 3 | 4;
  connections: Array<{ id: string; origin: string; pathPrefix: string }>;
  approvedBy: string;
  approvedAt: string;
}
export interface PluginProtectionView {
  contentHash: string;
  declaredLevel: number;
  allowedLevel: number;
  configurableMaximum: number;
  approval: PluginProtectionApproval | null;
  needsReview: boolean;
  explanation: string;
}
export interface ProtectedPluginTool {
  name: string;
  description?: string;
  effect: 'read' | 'write' | 'external';
  inputSchema: Record<string, unknown>;
}
