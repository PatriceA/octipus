import type { Page, WebSocketRoute } from '@playwright/test';
import { json, selectChatSession } from './fixtures/api-stubs';
import { expect, test } from './fixtures/auth';
import { stubGateway } from './fixtures/gateway';

// A live voice conversation in the chat (docs/VOICE.md → One pipeline): the
// browser is a transport. The microphone goes up the `/voice` socket in
// conversation mode, what the server hears as a finished turn comes back as
// `utterance` and is sent as the chat message (`spoken: true`), and the reply's
// speech comes back as PCM frames that are played. Nothing is synthesised here.

// A fake microphone, allowed without a prompt.
test.use({ launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] } });

interface VoiceSocketStub {
  /** The URL of every `/voice` connection the page opened, in order. */
  readonly urls: URL[];
  /** JSON messages the page sent. */
  readonly sent: Array<Record<string, unknown>>;
  /** Binary (microphone) frames received so far, and their total size. */
  readonly mic: { frames: number; bytes: number };
  /** Send a JSON message to the open socket. */
  send(message: Record<string, unknown>): void;
  /** Send an `audio` header and its frame. */
  audio(pcm: Buffer, sampleRate: number, seq: number): void;
}

async function stubVoiceSocket(page: Page, ready: { speak: boolean }): Promise<VoiceSocketStub> {
  const urls: URL[] = [];
  const sent: Array<Record<string, unknown>> = [];
  const mic = { frames: 0, bytes: 0 };
  let current: WebSocketRoute | null = null;
  await page.routeWebSocket((url) => url.pathname === '/voice', (ws) => {
    urls.push(new URL(ws.url()));
    current = ws;
    ws.onMessage((message) => {
      if (typeof message === 'string') sent.push(JSON.parse(message) as Record<string, unknown>);
      else {
        mic.frames++;
        mic.bytes += message.length;
      }
    });
    ws.send(JSON.stringify({ type: 'ready', mode: 'conversation', engine: 'local faster-whisper small', live: false, speak: ready.speak }));
  });
  return {
    urls,
    sent,
    mic,
    send: (message) => current?.send(JSON.stringify(message)),
    audio: (pcm, sampleRate, seq) => {
      current?.send(JSON.stringify({ type: 'audio', seq, format: 'pcm', sampleRate, ms: Math.round((pcm.length / 2 / sampleRate) * 1000), ...(seq === 0 ? { text: 'Hello there.' } : {}) }));
      current?.send(pcm);
    },
  };
}

/** `ms` of a quiet 440 Hz tone as mono s16le PCM. */
function tone(ms: number, sampleRate: number): Buffer {
  const samples = Math.round((sampleRate * ms) / 1000);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 2000), i * 2);
  return pcm;
}

async function startConversation(page: Page, speak = true) {
  const gateway = await stubGateway(page);
  await page.route('**/api/voice/status', (route) => json(route, 200, {
    mobileVoice: true, sttAvailable: true, sttReason: null, sttLocal: true, sttExternal: false, ttsAvailable: speak, ttsReason: speak ? null : 'No model is bound to the Speech lane.', language: 'en',
  }));
  const voice = await stubVoiceSocket(page, { speak });
  const synthesised: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/api/voice/speak')) synthesised.push(request.url());
  });
  await page.goto('/chat');
  await selectChatSession(page, 'sess-1');
  await expect.poll(() => gateway.subscribed()).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Start voice conversation' }).click();
  return { gateway, voice, synthesised, status: page.getByTestId('voice-conversation-status') };
}

test.describe('voice conversation in the chat', () => {
  test('opens the socket in conversation mode for the open chat and streams the microphone up', async ({ authenticatedPage: page }) => {
    const { gateway, voice, status } = await startConversation(page);
    await expect.poll(() => voice.urls.length).toBe(1);
    const url = voice.urls[0];
    expect(url.searchParams.get('mode')).toBe('conversation');
    expect(url.searchParams.get('session')).toBe('sess-1');
    expect(url.searchParams.get('token')).toBeTruthy();
    await expect(status).toHaveAttribute('data-state', 'listening');
    await expect(status).toHaveText('listening');
    // 16 kHz mono Int16: frames keep coming without anyone speaking (no voice detection in the browser).
    await expect.poll(() => voice.mic.frames, { timeout: 15_000 }).toBeGreaterThan(10);
    expect(voice.mic.bytes % 2).toBe(0);
    // The gateway still learns the chat is in voice mode.
    await expect.poll(() => gateway.sent.some((m) => m.type === 'voice.set' && m.on === true && m.sessionId === 'sess-1')).toBe(true);
  });

  test('a heard turn is sent as a spoken chat message, its reply is played, and talking over it stops it', async ({ authenticatedPage: page }) => {
    const { gateway, voice, synthesised, status } = await startConversation(page);
    await expect(status).toHaveAttribute('data-state', 'listening');

    voice.send({ type: 'speech_start' });
    voice.send({ type: 'transcript', text: 'what is the', final: false });
    await expect(status).toHaveText('what is the');
    voice.send({ type: 'utterance', text: 'What is the weather tomorrow?' });
    await expect.poll(() => gateway.sent.find((m) => m.type === 'chat.send')).toMatchObject({
      sessionId: 'sess-1', content: 'What is the weather tomorrow?', spoken: true,
    });
    await expect(status).toHaveAttribute('data-state', 'thinking');

    // The reply is spoken by the server: PCM frames, scheduled back to back.
    gateway.event('chat.response', { response: { response: 'Sunny, **22 °C**. [Source](https://example.com)' } }, 'sess-1');
    voice.send({ type: 'speaking', on: true });
    voice.audio(tone(200, 24_000), 24_000, 0);
    voice.audio(tone(200, 24_000), 24_000, 1);
    await expect(status).toHaveAttribute('data-state', 'speaking');
    await expect(status.getByRole('button', { name: 'Stop speaking' })).toBeVisible();

    voice.send({ type: 'barge_in' });
    await expect(status).toHaveAttribute('data-state', 'listening');
    await expect(status.getByRole('button', { name: 'Stop speaking' })).toHaveCount(0);

    // The browser never synthesised anything itself: no text went to /api/voice/speak.
    expect(synthesised).toEqual([]);
  });

  test('the stop button interrupts the reply, and a played reply reports when it has drained', async ({ authenticatedPage: page }) => {
    const { voice, status } = await startConversation(page);
    await expect(status).toHaveAttribute('data-state', 'listening');

    voice.send({ type: 'utterance', text: 'Tell me a story.' });
    voice.send({ type: 'speaking', on: true });
    voice.audio(tone(150, 24_000), 24_000, 0);
    await expect(status).toHaveAttribute('data-state', 'speaking');
    voice.send({ type: 'speaking', on: false });
    // Played to the end: the server is told, and the page listens again.
    await expect.poll(() => voice.sent.some((m) => m.type === 'playback' && m.state === 'ended'), { timeout: 15_000 }).toBe(true);
    await expect(status).toHaveAttribute('data-state', 'listening');

    voice.send({ type: 'utterance', text: 'Another one.' });
    voice.send({ type: 'speaking', on: true });
    voice.audio(tone(2000, 24_000), 24_000, 0);
    await expect(status).toHaveAttribute('data-state', 'speaking');
    await status.getByRole('button', { name: 'Stop speaking' }).click();
    await expect.poll(() => voice.sent.some((m) => m.type === 'interrupt')).toBe(true);
    await expect(status).toHaveAttribute('data-state', 'listening');
  });

  test('without a speech engine the conversation says it only listens, and a server error is shown', async ({ authenticatedPage: page }) => {
    const { voice, status } = await startConversation(page, false);
    await expect(status).toHaveText('Listening only — no speech engine');
    voice.send({ type: 'error', message: 'The speech-to-text engine stopped answering.' });
    await expect(status).toHaveText('The speech-to-text engine stopped answering.');
  });

  test('switching to another chat reopens the socket for that chat', async ({ authenticatedPage: page }) => {
    await page.route('**/api/sessions', (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const now = new Date().toISOString();
      return json(route, 200, { sessions: [
        { id: 'sess-1', title: 'First chat', status: 'active', updatedAt: now, createdAt: now, messageCount: 0 },
        { id: 'sess-2', title: 'Second chat', status: 'active', updatedAt: now, createdAt: now, messageCount: 0 },
      ] });
    });
    const { voice, status } = await startConversation(page);
    await expect(status).toHaveAttribute('data-state', 'listening');
    await selectChatSession(page, 'sess-2');
    await expect.poll(() => voice.urls.map((url) => url.searchParams.get('session'))).toEqual(['sess-1', 'sess-2']);
    await expect.poll(() => voice.sent.some((m) => m.type === 'stop')).toBe(true);
  });
});

// Dictation into the composer: the server's own engine whenever it has one.
test.describe('dictation', () => {
  const stubStatus = (page: Page, sttAvailable: boolean) => page.route('**/api/voice/status', (route) => json(route, 200, {
    mobileVoice: true, sttAvailable, sttReason: sttAvailable ? null : 'No model is bound to the Transcription lane.', ttsAvailable: false, ttsReason: null,
  }));

  test('with a speech engine on the server, a recording is transcribed there and lands in the composer; a failure is shown inline', async ({ authenticatedPage: page }) => {
    await stubGateway(page);
    await stubStatus(page, true);
    const bodies: Array<Record<string, unknown>> = [];
    await page.route('**/api/voice/transcribe', (route) => {
      bodies.push(route.request().postDataJSON() as Record<string, unknown>);
      return bodies.length === 1
        ? json(route, 200, { text: 'Remind me to call Anna', model: 'local faster-whisper small', language: 'en', duration: 1 })
        : json(route, 200, { error: 'The transcription engine is not running.' });
    });
    const dialogs: string[] = [];
    page.on('dialog', (dialog) => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    await page.goto('/chat');
    await selectChatSession(page, 'sess-1');

    const dictate = page.getByTestId('dictate-button');
    await expect(dictate).toHaveAttribute('data-dictation', 'server');
    await expect(dictate).toHaveAccessibleName('Dictate');
    await dictate.click();
    await page.getByRole('button', { name: 'Stop recording' }).click();
    await expect(page.getByPlaceholder('Send a message or change direction...')).toHaveValue('Remind me to call Anna');
    expect(bodies[0]).toMatchObject({ format: 'webm', sessionId: 'sess-1' });
    expect(typeof bodies[0].audio === 'string' && bodies[0].audio.length > 0).toBe(true);

    await page.getByTestId('dictate-button').click();
    await page.getByRole('button', { name: 'Stop recording' }).click();
    await expect(page.getByTestId('composer-voice-error')).toContainText('Dictation failed: The transcription engine is not running.');
    expect(dialogs).toEqual([]);
  });

  test('without a speech engine on the server, only the browser recognition is offered, and it says where the audio goes', async ({ authenticatedPage: page }) => {
    await page.addInitScript(() => {
      // A stand-in for the browser's own recognition (Chrome ships one; headless may not).
      class FakeRecognition {
        continuous = false; interimResults = false; lang = '';
        onresult: unknown = null; onerror: unknown = null; onend: (() => void) | null = null;
        start() {}
        stop() { this.onend?.(); }
      }
      (window as unknown as { webkitSpeechRecognition: unknown }).webkitSpeechRecognition = FakeRecognition;
    });
    await stubGateway(page);
    await stubStatus(page, false);
    let transcribed = false;
    await page.route('**/api/voice/transcribe', (route) => { transcribed = true; return json(route, 200, { text: 'x' }); });
    await page.goto('/chat');
    await selectChatSession(page, 'sess-1');

    const dictate = page.getByTestId('dictate-button');
    await expect(dictate).toHaveAttribute('data-dictation', 'browser');
    await expect(dictate).toHaveAccessibleName(/audio is sent to the browser vendor/);
    // No server engine: no voice conversation either.
    await expect(page.getByRole('button', { name: 'Start voice conversation' })).toHaveCount(0);
    await dictate.click();
    await page.getByRole('button', { name: 'Stop listening' }).click();
    expect(transcribed).toBe(false);
  });
});
