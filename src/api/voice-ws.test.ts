/**
 * Opening a voice conversation on `/voice` (src/api/voice-ws.ts): who may open
 * one on which chat, which engines it uses, and that a socket closed while the
 * conversation opens leaves nothing behind.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

const fx = vi.hoisted(() => ({
  sessions: new Map<string, { id: string; userId: string }>(),
  admins: new Set<string>(),
  requests: [] as Array<{ kind: string; req: Record<string, unknown> }>,
  tracked: new Set<unknown>(),
  startGate: null as Promise<void> | null,
  started: 0,
  closed: 0,
}));

vi.mock('@/security/auth/session', () => ({ getSessionManager: () => ({ validate: async (token: string) => (token === 'good' ? { userId: 'u1' } : null) }) }));
vi.mock('@/security/user-change-marks', () => ({ userChangeMark: () => 0 }));
vi.mock('./user-sockets', () => ({
  trackUserSocket: (_userId: string, ws: unknown) => { fx.tracked.add(ws); return () => { fx.tracked.delete(ws); }; },
}));
vi.mock('@/db/repositories/session-repository', () => ({ sessionRepository: { findById: async (id: string) => fx.sessions.get(id) ?? null } }));
vi.mock('@/core/rooms/access', () => ({ canActInSession: async (session: { userId: string } | null, userId: string) => !!session && session.userId === userId }));
vi.mock('@/db/repositories/user-repository', () => ({ userRepository: { findById: async (id: string) => ({ id, isAdmin: fx.admins.has(id) }) } }));
vi.mock('@/models/install-access', () => ({ mayUseInstallModels: async () => true }));
vi.mock('@/config/settings-service', () => ({ getSettingsService: () => ({ get: async () => undefined }) }));
vi.mock('@/core/gateway/hub', () => ({ getGatewayHub: () => ({ eventBus: { subscribe: () => () => {} } }) }));
vi.mock('@/voice/resolve', () => ({
  speechStatus: async (_direction: string, req: Record<string, unknown>) => { fx.requests.push({ kind: 'tts-status', req: { ...req } }); return { available: true }; },
  resolveSttEngine: async (req: Record<string, unknown>) => {
    fx.requests.push({ kind: 'stt', req: { ...req } });
    return { engine: { live: false, transcribe: async () => ({ text: '' }), streamTranscribe: async function* () {}, dispose: async () => {} }, name: 'fasterwhisper', row: { name: 'fw' } };
  },
  speechRowStaysLocal: async () => true,
  transcribeWithLane: async (_wav: Buffer, req: Record<string, unknown>) => { fx.requests.push({ kind: 'transcribe', req: { ...req } }); return { text: 'hello' }; },
  warmSpeechEngines: async () => {},
  streamSpeechWithLane: async () => { throw new Error('unused'); },
  recordSpeechUsage: async () => {},
  speechRowRefusal: async () => null,
}));
vi.mock('@/voice/session', () => ({
  VoiceSession: class {
    constructor(public options: unknown, public deps: { transcribe(wav: Buffer): Promise<string>; resolveStt(): Promise<unknown> }) {}
    async start() { fx.started += 1; await this.deps.resolveStt(); if (fx.startGate) await fx.startGate; }
    async close() { fx.closed += 1; }
    pushAudio() {}
  },
}));

import { setupVoiceWebSocket } from './voice-ws';

type Handlers = { open(ws: FakeSocket): Promise<void>; close(ws: FakeSocket): void };
interface FakeSocket { data: Record<string, unknown> & { request: { url: string } }; sent: string[]; closedWith: number | null; send(d: string): void; close(code?: number): void }

let handlers: Handlers;
setupVoiceWebSocket({ ws: (_path: string, h: Handlers) => { handlers = h; } } as never);

const CHAT = '11111111-2222-3333-4444-555555555555';
function socket(query: string): FakeSocket {
  const ws: FakeSocket = {
    data: { request: { url: `http://x/voice?token=good&mode=conversation&${query}` } },
    sent: [], closedWith: null,
    send(d) { this.sent.push(d); },
    close(code) { this.closedWith = code ?? 1000; },
  };
  return ws;
}

beforeEach(() => {
  fx.sessions.clear(); fx.admins.clear(); fx.requests = []; fx.tracked.clear();
  fx.startGate = null; fx.started = 0; fx.closed = 0;
});

describe('opening a voice conversation', () => {
  test('on someone else\'s chat is refused', async () => {
    fx.sessions.set(CHAT, { id: CHAT, userId: 'someone-else' });
    const ws = socket(`session=${CHAT}`);
    await handlers.open(ws);
    expect(ws.closedWith).toBe(4002);
    expect(fx.started).toBe(0);
    expect(fx.tracked.size).toBe(0);
  });

  test('a fresh chat counts for protection from the moment it exists', async () => {
    const ws = socket(`session=${CHAT}`);
    await handlers.open(ws);
    expect(fx.requests.find((r) => r.kind === 'stt')?.req.sessionId).toBeUndefined();
    const conversation = ws.data.conversation as { deps: { transcribe(wav: Buffer): Promise<string> } };
    // The first utterance's chat message created it.
    fx.sessions.set(CHAT, { id: CHAT, userId: 'u1' });
    await conversation.deps.transcribe(Buffer.alloc(0));
    expect(fx.requests.at(-1)).toMatchObject({ kind: 'transcribe', req: { sessionId: CHAT } });
  });

  test('a chat that turns up owned by someone else stops the conversation\'s engines', async () => {
    const ws = socket(`session=${CHAT}`);
    await handlers.open(ws);
    const conversation = ws.data.conversation as { deps: { transcribe(wav: Buffer): Promise<string> } };
    fx.sessions.set(CHAT, { id: CHAT, userId: 'someone-else' });
    await expect(conversation.deps.transcribe(Buffer.alloc(0))).rejects.toThrow('Session not found');
  });

  test('an engine named on the URL counts for an admin only, and each direction has its own', async () => {
    await handlers.open(socket(`session=${CHAT}&engine=cloud-stt&tts=cloud-tts`));
    expect(fx.requests.find((r) => r.kind === 'stt')?.req.override).toBeNull();
    expect(fx.requests.find((r) => r.kind === 'tts-status')?.req.override).toBeNull();

    fx.requests = [];
    fx.admins.add('u1');
    await handlers.open(socket(`session=${CHAT}&engine=cloud-stt&tts=cloud-tts`));
    expect(fx.requests.find((r) => r.kind === 'stt')?.req.override).toBe('cloud-stt');
    expect(fx.requests.find((r) => r.kind === 'tts-status')?.req.override).toBe('cloud-tts');
  });

  test('a socket closed while the conversation opens is not left in the user\'s socket list', async () => {
    let release: () => void = () => {};
    fx.startGate = new Promise<void>((resolve) => { release = resolve; });
    const ws = socket(`session=${CHAT}`);
    const opening = handlers.open(ws);
    await vi.waitFor(() => expect(fx.started).toBe(1));
    handlers.close(ws);
    release();
    await opening;
    expect(fx.tracked.size).toBe(0);
    expect(fx.closed).toBe(1);
    expect(ws.data.conversation).toBeUndefined();
  });
});
