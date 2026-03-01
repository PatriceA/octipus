export { OrchestratorService, getOrchestratorService } from './service';
export type { OrchestratorEvent } from './service';
export { MessageDispatcher, getMessageDispatcher } from './dispatcher';
export { PipelineManager, getPipelineManager } from './pipeline-manager';
export { getPipelineTemplate, buildStagesFromTemplate, expandPromptTemplate } from './templates';
export { classifyMessage } from './classifier';
export { filterPII } from './pii-filter';
export { createMetaTools } from './meta-tools';
export { getRoleConfig, getToolsForRole, ROLE_CONFIGS } from './roles';
export type {
  AgentRole,
  Pipeline,
  PipelineStage,
  PipelineStatus,
  StageStatus,
  RoleConfig,
  MessageClassification,
  PIIFilterResult,
  PIIRedaction,
  WorkerResult,
} from './types';
