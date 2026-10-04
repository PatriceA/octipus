import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { sessionGeneration } from '@/db/schema/sessions';
import type { Session } from '@/db/schema/sessions';
import { agentRepository } from '@/db/repositories/agent-repository';
import { getCLIToolConfig, resolveCliModelEntry } from './cli-agent-factory';
import { cliSessionKeyAdapter, isChildCliSessionKey } from './cli-session-store';
import { cliCredentialOwnerFor, cliEnvFor } from './cli-child-env';
import { WorkspaceFS } from '@/security/workspace-fs';
import { acquireCliSlot, execCli, windowsShellQuote, windowsShellQuoter } from '@/models/providers/cli-provider';
import { discoverCodexMcpServers } from './cli-adapters';
import { killProcessTree } from '@/utils/proc';
import { recordProviderUsage } from '@/models/providers/instrumented';
import type { CompletionResult } from '@/models/litellm-client';

export function rootCliConversation(session: Session) {
  return Object.entries(session.context?.cliSessions ?? {})
    .filter(([key, record]) => !isChildCliSessionKey(key) && record.generation === sessionGeneration(session.context))
    .sort((a, b) => b[1].lastUsedAt.localeCompare(a[1].lastUsedAt))[0];
}

/** Called under the conversation lock. Never replaces or clears a vendor ID. */
export async function compactCliConversation(session: Session, instructions: string): Promise<string | null> {
  const current = rootCliConversation(session);
  if (!current) return null;
  const [key, record] = current;
  const adapter = cliSessionKeyAdapter(key);
  if (!record.ownerAgentId) throw new Error('CLI session has no owning agent; cannot safely resolve its provider.');
  const owner = await agentRepository.findById(record.ownerAgentId);
  if (!owner || owner.sessionId !== session.id || owner.userId !== session.userId) throw new Error('CLI session owner is unavailable.');
  const tool = getCLIToolConfig(owner.model);
  if (!tool || (tool.adapter ?? tool.name) !== adapter) throw new Error('CLI session adapter no longer matches its model.');
  // The row the vendor session ran on — its credentials are the ones that own
  // the vendor conversation (§8.5). A mismatch means the record was written
  // under another owner: refuse rather than compact it with the wrong login.
  const model = await resolveCliModelEntry(owner.model, { modelName: record.modelName, userId: owner.userId });
  const credentialOwner = await cliCredentialOwnerFor(model);
  if ((credentialOwner?.userId ?? undefined) !== record.credentialOwner) throw new Error('CLI session credentials no longer match its model.');
  const env = cliEnvFor(credentialOwner, tool, await tool.buildEnv?.(), model?.metadata?.cliAgent?.inheritApiKeys === true);
  const cwd = resolve(WorkspaceFS.forSession(session).root);
  const release = await acquireCliSlot();
  let usage: CompletionResult['usage'] = { inputTokens: 0, outputTokens: 0, totalTokens: 0, available: false };
  let completed = false;
  try {
    if (adapter === 'Claude Code') {
      const output = await execCli(tool.binaryPath, ['--print', '--resume', record.id,
        '--output-format', 'stream-json', '--verbose', '--tools', '', '--strict-mcp-config',
        '--settings', JSON.stringify({ disableAllHooks: true })], {
        cwd, env, timeoutMs: 300_000, stdin: `/compact${instructions ? ` ${instructions}` : ''}`,
      });
      const events = output.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      const reported = events.findLast(event => event.type === 'result')?.usage;
      if (reported) {
        const inputTokens = (reported.input_tokens ?? 0) + (reported.cache_read_input_tokens ?? 0) + (reported.cache_creation_input_tokens ?? 0);
        usage = { inputTokens, outputTokens: reported.output_tokens ?? 0, totalTokens: inputTokens + (reported.output_tokens ?? 0),
          cacheReadTokens: reported.cache_read_input_tokens, cacheCreationTokens: reported.cache_creation_input_tokens };
      }
      if (!events.some(event => event.type === 'system' && event.subtype === 'compact_boundary' && event.session_id === record.id)
        || events.some(event => event.type === 'result' && event.is_error)) {
        throw new Error('CLI did not confirm native compaction. The existing session was retained.');
      }
    } else if (adapter === 'Codex CLI') {
      if (instructions) throw new Error('Codex native compaction does not accept focus instructions; use /compact without arguments.');
      const servers = await discoverCodexMcpServers(cwd);
      const args = ['app-server', ...servers.flatMap(server => ['-c', `mcp_servers.${JSON.stringify(server.name)}.enabled=false`])];
      usage = await compactCodexThread(tool.binaryPath, args, { cwd, env, threadId: record.id });
    } else {
      throw new Error(`Native compaction is not supported for ${adapter}; the existing session was retained.`);
    }
    completed = true;
    return `${adapter} conversation compacted. Continuing with the same CLI session.`;
  } finally {
    release();
    await recordProviderUsage({ model: owner.model, messages: [], userId: session.userId, sessionId: session.id,
      modelConfigName: model?.name, requestType: 'compaction', workspaceId: session.workspaceId ?? null,
      accountingMetadata: { purpose: 'cli_compaction' } }, 'cli', { usage, model: owner.model }, !completed);
  }
}

export function compactCodexThread(binary: string, args: string[], options: { cwd: string; env: Record<string, string>; threadId: string }): Promise<CompletionResult['usage']> {
  return new Promise((resolvePromise, reject) => {
    const shell = process.platform === 'win32';
    const child = spawn(shell ? windowsShellQuote(binary) : binary, shell ? args.map(windowsShellQuoter(binary)) : args,
      { cwd: options.cwd, env: options.env, shell, detached: !shell, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let settled = false;
    let buffer = '';
    let compactRequested = false;
    let compactTurn: string | undefined;
    let completedItem = false;
    let usage: CompletionResult['usage'] = { inputTokens: 0, outputTokens: 0, totalTokens: 0, available: false };
    const timer = setTimeout(() => finish(new Error('Native CLI compaction timed out; session retained.')), 300_000);
    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      killProcessTree(child.pid, child);
      if (error) reject(error); else resolvePromise(usage);
    }
    function send(value: unknown) { child.stdin.write(`${JSON.stringify(value)}\n`); }
    child.on('error', () => finish(new Error('Could not start Codex compaction.')));
    child.stdin.on('error', () => finish(new Error('Codex compaction connection closed.')));
    child.stderr.resume(); // never echo provider output or credentials
    child.on('close', () => finish(new Error('Codex exited before confirming compaction.')));
    child.stdout.on('data', chunk => {
      if (settled) return;
      buffer += chunk.toString();
      if (buffer.length > 16 * 1024 * 1024) return finish(new Error('Codex compaction response exceeded its size limit.'));
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.error) return finish(new Error('Codex rejected native compaction; session retained.'));
        if (message.id === 1) {
          send({ method: 'initialized', params: {} });
          send({ id: 2, method: 'thread/resume', params: { threadId: options.threadId, cwd: options.cwd, approvalPolicy: 'never', sandbox: 'read-only' } });
        } else if (message.id === 2) {
          if (message.result?.thread?.id !== options.threadId) return finish(new Error('Codex resumed an unexpected thread.'));
          compactRequested = true;
          send({ id: 3, method: 'thread/compact/start', params: { threadId: options.threadId } });
        } else if (compactRequested && message.params?.threadId === options.threadId) {
          if (message.method === 'thread/tokenUsage/updated' && message.params.tokenUsage?.last) {
            const last = message.params.tokenUsage.last;
            usage = { inputTokens: last.inputTokens ?? 0, outputTokens: last.outputTokens ?? 0,
              totalTokens: last.totalTokens ?? (last.inputTokens ?? 0) + (last.outputTokens ?? 0), cacheReadTokens: last.cachedInputTokens };
          }
          if (message.method === 'turn/started') compactTurn = message.params.turn?.id;
          if (message.method === 'item/completed' && message.params.turnId === compactTurn && message.params.item?.type === 'contextCompaction') completedItem = true;
          if (message.method === 'turn/completed' && compactTurn && message.params.turn?.id === compactTurn) {
            return finish(message.params.turn.status === 'completed' && completedItem ? undefined : new Error('Codex compaction failed; session retained.'));
          }
        }
        if (message.method && message.id !== undefined) send({ id: message.id, error: { code: -32601, message: 'Maintenance does not accept tool or approval requests' } });
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'octipus_compact', version: '1.0.0' } } });
  });
}
