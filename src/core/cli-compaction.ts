import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { sessionGeneration } from '@/db/schema/sessions';
import type { Session } from '@/db/schema/sessions';
import { agentRepository } from '@/db/repositories/agent-repository';
import { getCLIToolConfig, resolveCliModelEntry } from './cli-agent-factory';
import { cliSessionKeyAdapter, isChildCliSessionKey } from './cli-session-store';
import { cliCredentialOwnerFor, cliEnvFor } from './cli-child-env';
import { sessionFsAccess, WorkspaceFS } from '@/security/workspace-fs';
import { acquireCliSlot, execCli, windowsShellQuote, windowsShellQuoter } from '@/models/providers/cli-provider';
import { discoverCodexMcpServers, disposeMuseHome, mspLine, museWorkspaceFor, prepareMuseHome } from './cli-adapters';
import { configuredCliBinary } from './cli-executable';
import { v7 as uuidv7 } from 'uuid';
import { killProcessTree } from '@/utils/proc';
import { recordProviderUsage } from '@/models/providers/instrumented';
import type { CompletionResult } from '@/models/litellm-client';

export async function rootCliConversation(session: Session) {
  const candidates = Object.entries(session.context?.cliSessions ?? {})
    .filter(([key, record]) => !isChildCliSessionKey(key) && record.generation === sessionGeneration(session.context))
    .filter(([, record]) => !session.context?.clearedAt || record.lastUsedAt > session.context.clearedAt);
  if (!candidates.length) return undefined;
  // A cold run without a saved vendor session may leave older vendor IDs
  // behind. Those are not the conversation the user just had, even when the
  // adapter matches. Only the latest root's own saved vendor ID is eligible.
  const latest = await agentRepository.findLatestRootForSession(session.id, session.userId);
  if (!latest) return undefined;
  return candidates.find(([, record]) => record.ownerAgentId === latest.id);
}

/**
 * Called under the conversation lock. Never replaces or clears a vendor ID.
 *
 * `requesterId` is who asked (`/compact`). The pass runs on the row the vendor
 * conversation ran on — an install row, or the requester's own personal row —
 * and never on another user's: in a space session the most recent root
 * conversation can be another member's, on their own subscription, and
 * compacting it would spend their login on the requester's command.
 */
export async function compactCliConversation(session: Session, instructions: string, requesterId: string): Promise<string | null> {
  const current = await rootCliConversation(session);
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
  if (model?.ownerUserId && model.ownerUserId !== requesterId) {
    throw new Error('This CLI conversation runs on another member\'s personal model; only they can compact it.');
  }
  const credentialOwner = await cliCredentialOwnerFor(model, requesterId);
  if ((credentialOwner?.userId ?? undefined) !== record.credentialOwner) throw new Error('CLI session credentials no longer match its model.');
  const env = cliEnvFor(credentialOwner, tool, await tool.buildEnv?.(), model?.metadata?.cliAgent?.inheritApiKeys === true);
  const cwd = resolve(WorkspaceFS.forSession(session, await sessionFsAccess(session, requesterId)).root);
  const release = await acquireCliSlot();
  let usage: CompletionResult['usage'] = { inputTokens: 0, outputTokens: 0, totalTokens: 0, available: false };
  let completed = false;
  try {
    if (adapter === 'Claude Code') {
      // The model the conversation runs on, resolved as the agent run does
      // (`buildClaudeArgs`): without it the summary ran on the CLI's default
      // model. Tool parity is not reachable here — the session's tools come
      // from the Octipus bridge, which only a live run starts — so this pass
      // still reads the conversation outside its prompt cache.
      const claudeModel = process.env.CLAUDE_MODEL || model?.metadata?.cliAgent?.model;
      const output = await execCli(tool.binaryPath, ['--print', '--resume', record.id,
        ...(claudeModel ? ['--model', claudeModel] : []),
        '--output-format', 'stream-json', '--verbose', '--tools', '', '--strict-mcp-config',
        // A personal row reads no settings file from the owner's cli-home (§8.4).
        ...(credentialOwner ? ['--setting-sources='] : []),
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
      const servers = await discoverCodexMcpServers(cwd, env);
      // Codex splits dotted override paths literally: a quoted name becomes
      // a new, invalid server rather than disabling the configured one.
      // Put quoted names inside a TOML table, as the agent launcher does.
      const args = ['app-server', '-c', `mcp_servers={${servers.map(server => `${JSON.stringify(server.name)}={enabled=false}`).join(',')}}`];
      usage = await compactCodexThread(tool.binaryPath, args, { cwd, env, threadId: record.id });
    } else if (adapter === 'Muse Code') {
      if (instructions) throw new Error('Muse Code native compaction does not accept focus instructions; use /compact without arguments.');
      // A config home with no tools: compaction calls none, and the session's
      // bridge is gone with its run.
      const home = await prepareMuseHome({ workspace: museWorkspaceFor(cwd), tools: [], env });
      try {
        const noop = await compactMuseSession(configuredCliBinary(tool.binaryPath), { cwd, env: { ...env, XDG_CONFIG_HOME: home }, sessionId: record.id });
        completed = true;
        if (noop) return `Muse Code had nothing to compact (${noop}). Continuing with the same CLI session.`;
      } finally {
        disposeMuseHome(home, env);
      }
    } else {
      throw new Error(`Native compaction is not supported for ${adapter}; the existing session was retained.`);
    }
    completed = true;
    return `${adapter} conversation compacted. Continuing with the same CLI session.`;
  } finally {
    release();
    await recordProviderUsage({ model: owner.model, messages: [], userId: requesterId, sessionId: session.id,
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
    child.on('close', (code, signal) => finish(new Error(`Codex exited before confirming compaction (${signal ? `signal ${signal}` : `exit ${code ?? 'unknown'}`}); session retained.`)));
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

/**
 * Compacts a muse session through its session protocol (`muse serve`):
 * resume it, `session/compact`, and wait for the compaction item's outcome.
 * Resolves with the reason when muse found nothing to compact. muse compacts
 * only when it knows the model's context limit, which `muse serve` reads from
 * the model catalog cached by `muse exec` or the interactive `muse` and never
 * fetches itself; without one it refuses with `compaction_unavailable`.
 */
export function compactMuseSession(binary: string, options: { cwd: string; env: Record<string, string>; sessionId: string }): Promise<string | undefined> {
  return new Promise((resolvePromise, reject) => {
    const shell = process.platform === 'win32';
    const args = ['serve', '--disable-request-user-input', '-c', 'run.reminder_roster=[]'];
    const child = spawn(shell ? windowsShellQuote(binary) : binary, shell ? args.map(windowsShellQuoter(binary)) : args,
      { cwd: options.cwd, env: options.env, shell, detached: !shell, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let settled = false;
    let buffer = '';
    // Set once muse confirmed: serve is then let exit on its own (end of
    // input flushes its session log), killed only if it lingers.
    let confirmed: { noop?: string } | undefined;
    const timer = setTimeout(() => finish(new Error('Muse Code compaction timed out; session retained.')), 300_000);
    function confirm(noop?: string) {
      confirmed = { noop };
      child.stdin.end();
      setTimeout(() => finish(undefined, noop), 10_000).unref();
    }
    // Settles only once serve has exited: the caller then removes its config
    // home, and a login muse is still renaming into it must not be lost.
    let closed = false;
    let outcome: (() => void) | undefined;
    function finish(error?: Error, noop?: string) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      outcome = () => error ? reject(error) : resolvePromise(noop);
      if (closed) return outcome();
      child.stdin.end();
      killProcessTree(child.pid, child);
    }
    child.on('error', () => { closed = true; finish(new Error('Could not start Muse Code compaction.')); outcome?.(); });
    child.stdin.on('error', () => finish(new Error('Muse Code compaction connection closed.')));
    child.stderr.resume(); // never echo provider output or credentials
    child.on('close', (code, signal) => {
      closed = true;
      finish(confirmed ? undefined : new Error(`Muse Code exited before confirming compaction (${signal ? `signal ${signal}` : `exit ${code ?? 'unknown'}`}); session retained.`), confirmed?.noop);
      outcome?.();
    });
    child.stdout.on('data', chunk => {
      if (settled || confirmed) return;
      buffer += chunk.toString();
      if (buffer.length > 16 * 1024 * 1024) return finish(new Error('Muse Code compaction response exceeded its size limit.'));
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.error) {
          const reason = message.error.data?.reason ?? message.error.message;
          return finish(new Error(reason === 'compaction_unavailable'
            ? 'Muse Code cannot compact this session: it knows no context limit for its model. `muse serve` reads that from the model catalog `muse exec` or the interactive `muse` cache, and fetches none itself; run either once as this account. Session retained.'
            : `Muse Code refused compaction (${String(reason)}); session retained.`));
        }
        if (message.method && message.id !== undefined) return finish(new Error(`Muse Code asked for ${message.method} during compaction; session retained.`));
        if (message.id === 2) {
          child.stdin.write(mspLine(3, 'session/compact', { commandId: uuidv7(), sessionId: options.sessionId }));
        } else if (message.id === 3 && message.result?.status === 'noop') {
          return confirm(String(message.result.reason ?? 'noop'));
        } else if (message.method === 'item/completed' && message.params?.item?.kind === 'compaction' && message.params.sessionId === options.sessionId) {
          const item = message.params.item;
          if (item.outcome === 'compacted' || item.outcome === 'noop') return confirm(item.outcome === 'noop' ? String(item.reason ?? 'noop') : undefined);
          return finish(new Error(`Muse Code compaction ${String(item.outcome)}${item.reason ? ` (${String(item.reason)})` : ''}; session retained.`));
        }
      }
    });
    child.stdin.write(mspLine(1, 'initialize', { clientInfo: { name: 'octipus_compact', version: '1.0.0' } }) + mspLine(undefined, 'initialized')
      + mspLine(2, 'session/resume', { commandId: uuidv7(), sessionId: options.sessionId, excludeItems: true }));
  });
}
