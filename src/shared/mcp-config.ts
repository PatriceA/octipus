import { z } from 'zod';
import type { MCPServer } from './mcp-server';

/** Credentials are write-only in the settings editor. Null explicitly removes one. */
export const mcpServerEditSchema = z.object({
  revision: z.string().min(1),
  trustRecoveryHints: z.boolean().optional(),
  name: z.string().trim().min(1).optional(),
  transport: z.enum(['stdio', 'sse', 'streamable-http']).optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  sseUrl: z.string().optional(),
  postUrl: z.string().optional(),
  authorization: z.string().nullable().optional(),
  envPatch: z.record(z.string().min(1), z.string().nullable()).optional(),
}).strict();
export type MCPServerEdit = z.infer<typeof mcpServerEditSchema>;
export type MCPServerConfigView = Omit<MCPServer, 'env' | 'headers'> & {
  revision: string;
  hasAuthorization: boolean;
  envNames: string[];
};
export type MCPServerSummary = Omit<MCPServer, 'env' | 'headers'> & {
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  error?: string;
  toolCount: number;
  resourceCount: number;
  promptCount: number;
};
