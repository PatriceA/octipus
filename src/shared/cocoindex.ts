/** The managed CocoIndex Code MCP server's id. */
export const COCOINDEX_SERVER_ID = 'cocoindex-code' as const;
/**
 * The env key that marks the managed server in the MCP server config. Its
 * name predates the code index's move out of the removed connector framework;
 * existing installs store it, so it is kept.
 */
export const COCOINDEX_MANAGED_ENV = 'OCTIPUS_MANAGED_CONNECTOR' as const;

/** Where the managed daemon embeds through (`src/api/routes/code-index.ts`). */
export const COCOINDEX_EMBEDDING_PATH = '/api/code-index/cocoindex';
/** The path a daemon set up before the code index left the removed connector framework still names. */
const LEGACY_COCOINDEX_EMBEDDING_PATH = '/api/connectors/cocoindex';

/** `base` with the legacy embedding path replaced by the current one; unchanged otherwise. */
export function currentCocoIndexEmbeddingBase(base: string): string {
  try {
    const url = new URL(base);
    if (url.pathname !== LEGACY_COCOINDEX_EMBEDDING_PATH && !url.pathname.startsWith(`${LEGACY_COCOINDEX_EMBEDDING_PATH}/`)) return base;
    url.pathname = COCOINDEX_EMBEDDING_PATH + url.pathname.slice(LEGACY_COCOINDEX_EMBEDDING_PATH.length);
    return url.toString();
  } catch {
    return base;
  }
}

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
  id: typeof COCOINDEX_SERVER_ID;
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
    provider: 'sentence-transformers' | 'octipus';
    model: string;
    local: boolean;
  };
}

