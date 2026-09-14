export const COCOINDEX_CONNECTOR_ID = 'cocoindex-code' as const;
export const COCOINDEX_DEFAULT_EMBEDDING_MODEL = 'Snowflake/snowflake-arctic-embed-xs';

export type CocoIndexState =
  | 'not_installed'
  | 'installing'
  | 'configuring'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';

export type CocoIndexProgressPhase = 'install' | 'initialize' | 'connect';

export interface CocoIndexStatus {
  id: typeof COCOINDEX_CONNECTOR_ID;
  installed: boolean;
  configured: boolean;
  workspacePath: string | null;
  status: CocoIndexState;
  error?: string;
  progress?: {
    phase: CocoIndexProgressPhase;
    message: string;
  };
  embedding: {
    provider: 'sentence-transformers';
    model: string;
    local: true;
  };
}

