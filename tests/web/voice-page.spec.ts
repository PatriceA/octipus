import type { Page } from '@playwright/test';
import { json } from './fixtures/api-stubs';
import { expect, test } from './fixtures/auth';

// Settings → Voice (docs/VOICE.md): what hears and speaks, adding and
// installing an engine, voices, and trying them — against the routes of
// src/api/routes/voice.ts, stubbed with the shapes they answer.

const speech = (over: Record<string, unknown> = {}) => ({
  voices: [], instructions: 'none', cloning: false, speed: true, streams: false, sampleRate: null, formats: ['wav'],
  realtime: null, upload: 'any', device: null, ...over,
});

const WHISPER = {
  name: 'local faster-whisper small', direction: 'stt', kind: 'fasterwhisper', modelId: 'small', endpoint: null, apiKeyRef: null,
  role: 'primary', local: true, available: true, reason: null, speech: speech({ formats: [], device: 'auto' }),
};
const VOXTRAL_STT = {
  name: 'mistral voxtral-mini', direction: 'stt', kind: 'mistral', modelId: 'voxtral-mini-latest', endpoint: null, apiKeyRef: null,
  role: null, local: false, available: false, reason: 'No Mistral API key is stored.', speech: speech({ formats: [], realtime: 'mistral' }),
};
const VOXCPM = {
  name: 'speech openbmb/VoxCPM2', direction: 'tts', kind: 'compatible', modelId: 'openbmb/VoxCPM2', endpoint: 'http://gpu-box:8000/v1', apiKeyRef: null,
  role: 'primary', local: true, available: true, reason: null, speech: speech({ instructions: 'prefix', cloning: true, streams: true, sampleRate: 48000 }),
};

const CATALOG = [
  { kind: 'fasterwhisper', direction: 'stt', label: 'faster-whisper', local: true, installable: true, note: 'On this machine, free, private. Needs uv and ffmpeg.',
    sizes: [{ id: 'small', download: '0.5 GB', ram: '2 GB', note: 'A good start.' }, { id: 'large-v3', download: '3 GB', ram: '10 GB', note: 'Most accurate.' }] },
  { kind: 'mistral', direction: 'stt', label: 'Voxtral (Mistral)', local: false, installable: false, note: 'Cloud. Uses your Mistral key; streams live.' },
  { kind: 'kokoro', direction: 'tts', label: 'Kokoro', local: true, installable: true, note: 'On this machine, natural voices. Needs uv.' },
  { kind: 'piper', direction: 'tts', label: 'Piper', local: true, installable: false, note: 'On this machine, very small.' },
];

interface Overview {
  hear: Record<string, unknown>;
  speak: Record<string, unknown>;
  engines: Array<Record<string, unknown>>;
  catalog: typeof CATALOG;
  jobs: Array<Record<string, unknown>>;
  host: { uv: boolean; ffmpeg: boolean };
}

const overviewOf = (over: Partial<Overview> = {}): Overview => ({
  hear: { available: true, model: WHISPER.name, engine: 'fasterwhisper', local: true, reason: null },
  speak: { available: true, model: VOXCPM.name, engine: 'compatible', local: true, reason: null },
  engines: [WHISPER, VOXTRAL_STT, VOXCPM],
  catalog: CATALOG,
  jobs: [],
  host: { uv: true, ffmpeg: true },
  ...over,
});

/** A valid, silent WAV: what `POST /voice/speak` answers with here. */
function silentWav(ms = 100, rate = 8000): Buffer {
  const samples = Math.round((rate * ms) / 1000);
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + samples * 2, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(samples * 2, 40);
  return wav;
}

/** The Voice page's reads. `state.overview` may be replaced between polls. */
async function stubVoice(page: Page, state: { overview: Overview; profiles?: Array<Record<string, unknown>>; voices?: string[] }): Promise<void> {
  await page.route('**/api/voice/engines', (route) => json(route, 200, state.overview));
  await page.route('**/api/voice/voices', (route) => json(route, 200, {
    model: state.overview.speak.model, voices: state.voices ?? [], active: '', profiles: state.profiles ?? [],
  }));
  await page.route('**/api/settings', (route) => json(route, 200, {
    categories: ['voice'],
    settings: { voice: [
      { key: 'voice.language', value: 'en', valueType: 'string', defaultValue: 'en', description: 'Voice language code', isSecret: false, category: 'voice' },
      { key: 'voice.endpointSilenceMs', value: 700, valueType: 'number', defaultValue: 700, description: 'pause', isSecret: false, category: 'voice' },
      { key: 'voice.bargeIn', value: true, valueType: 'boolean', defaultValue: true, description: 'barge', isSecret: false, category: 'voice' },
      { key: 'voice.ttsVoice', value: 'af_sarah', valueType: 'string', defaultValue: '', description: 'legacy', isSecret: false, category: 'voice' },
      { key: 'voice.telephonyProvider', value: 'disabled', valueType: 'string', defaultValue: 'disabled', description: 'provider', isSecret: false, category: 'voice' },
    ] },
  }));
}

test.describe('Settings → Voice', () => {
  test('shows what hears and speaks now, each engine with whether it can run, and no raw setting keys', async ({ authenticatedPage: page }) => {
    await stubVoice(page, { overview: overviewOf({
      speak: { available: false, model: null, engine: null, local: false, reason: 'No model is bound to the Speech lane.' },
      engines: [WHISPER, VOXTRAL_STT],
    }) });
    await page.goto('/settings?tab=voice');

    await expect(page.getByTestId('voice-status-stt')).toHaveText('Now: local faster-whisper small · on this machine');
    // Off, with the reason as text on the page (not a tooltip).
    await expect(page.getByTestId('voice-status-tts')).toHaveText('Off — No model is bound to the Speech lane.');

    const hear = page.getByTestId('voice-stt');
    await expect(hear.getByRole('heading', { name: 'Hear (speech to text)' })).toBeVisible();
    const primary = hear.locator('[data-testid="engine-row"][data-engine="local faster-whisper small"]');
    await expect(primary).toContainText('Primary');
    await expect(primary).toContainText('Can run');
    const cloud = hear.locator('[data-testid="engine-row"][data-engine="mistral voxtral-mini"]');
    await expect(cloud).toContainText('Cannot run: No Mistral API key is stored.');
    await expect(cloud.getByRole('link', { name: 'Secrets' })).toHaveAttribute('href', '/secrets');

    await expect(page.getByRole('heading', { name: 'Speak (text to speech)' })).toBeVisible();
    for (const title of ['Voices', 'Conversation', 'Calls']) await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await expect(page.getByLabel('Language')).toHaveValue('en');
    await expect(page.getByRole('switch', { name: 'Talking over a reply stops it' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByLabel('Phone provider')).toHaveValue('disabled');
    // The page speaks in plain words: no raw setting keys, no engineering shorthand.
    await expect(page.getByTestId('voice-page')).not.toContainText(/ttsvoice|endpointSilenceMs|telephonyProvider|\b(TTS|STT)\b|Phase 4/i);
  });

  test('"Make primary" binds the engine to its lane and keeps the one it replaces as the backup', async ({ authenticatedPage: page }) => {
    await stubVoice(page, { overview: overviewOf() });
    let bound: unknown;
    await page.route('**/api/topics/transcription/binding', (route) => {
      bound = route.request().postDataJSON();
      return json(route, 200, { ok: true });
    });
    await page.goto('/settings?tab=voice');
    await page.locator('[data-testid="engine-row"][data-engine="mistral voxtral-mini"]').getByRole('button', { name: 'Make primary' }).click();
    await expect.poll(() => bound).toEqual({ primaryModel: 'mistral voxtral-mini', backupModel: 'local faster-whisper small' });
  });

  test('adding your own speech server posts it, and a refusal is shown in the form', async ({ authenticatedPage: page }) => {
    await stubVoice(page, { overview: overviewOf() });
    const posted: Array<Record<string, unknown>> = [];
    await page.route('**/api/voice/engines/server', (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      posted.push(body);
      return body.endpoint === 'http://nowhere'
        ? json(route, 400, { error: 'The server at http://nowhere did not answer.' })
        : json(route, 200, { model: 'Whisper turbo', lane: 'transcription', bound: 'primary' });
    });
    await page.goto('/settings?tab=voice');

    const form = page.getByTestId('own-server-stt');
    await expect(form).toContainText('Works with any OpenAI-compatible speech server');
    await expect(form.getByLabel('Endpoint URL')).toHaveAttribute('placeholder', 'http://localhost:8000/v1');
    await expect(form.getByLabel('Model id')).toHaveAttribute('placeholder', 'openai/whisper-large-v3-turbo');
    await expect(page.getByTestId('own-server-tts').getByLabel('Model id')).toHaveAttribute('placeholder', 'openbmb/VoxCPM2');

    await form.getByLabel('Endpoint URL').fill('http://nowhere');
    await form.getByLabel('Model id').fill('openai/whisper-large-v3-turbo');
    await form.getByRole('button', { name: 'Add server' }).click();
    await expect(page.getByTestId('own-server-error-stt')).toHaveText('The server at http://nowhere did not answer.');
    // What was typed is still there to correct.
    await expect(form.getByLabel('Model id')).toHaveValue('openai/whisper-large-v3-turbo');

    await form.getByLabel('Endpoint URL').fill('http://localhost:8000/v1');
    await form.getByLabel('Name (optional)', { exact: true }).fill('Whisper turbo');
    await form.getByLabel('API key name (optional)').fill('env:SPEECH_KEY');
    await form.getByRole('button', { name: 'Add server' }).click();
    await expect(form.getByRole('status')).toHaveText('Whisper turbo is now the primary.');
    await expect(page.getByTestId('own-server-error-stt')).toHaveCount(0);
    expect(posted[1]).toEqual({
      direction: 'stt', endpoint: 'http://localhost:8000/v1', modelId: 'openai/whisper-large-v3-turbo',
      name: 'Whisper turbo', apiKeyRef: 'env:SPEECH_KEY', makePrimary: true,
    });
  });

  test('Install starts the job on the server, follows its log while it runs, and shows the engine when it is done', async ({ authenticatedPage: page }) => {
    const state = { overview: overviewOf({ engines: [VOXCPM], hear: { available: false, model: null, engine: null, local: false, reason: 'No model is bound to the Transcription lane.' }, host: { uv: true, ffmpeg: false } }) };
    await stubVoice(page, state);
    let installBody: unknown;
    await page.route('**/api/voice/engines/install', (route) => {
      installBody = route.request().postDataJSON();
      const job = { engine: 'fasterwhisper', size: 'large-v3-turbo', stage: 'running', log: ['Creating the Python environment', 'Downloading large-v3-turbo (1.6 GB)'], startedAt: Date.now() };
      state.overview = { ...state.overview, jobs: [job] };
      return json(route, 200, { job });
    });
    await page.goto('/settings?tab=voice');

    const row = page.locator('[data-testid="catalog-row"][data-engine="fasterwhisper"]');
    // What the server lacks is said next to the engine that needs it.
    await expect(row.getByTestId('missing-tools')).toContainText('Not found on this server: ffmpeg');
    await expect(row.getByLabel('Model', { exact: true })).toHaveValue('small');
    await row.getByLabel('Or another model').fill('large-v3-turbo');
    await row.getByRole('button', { name: 'Install' }).click();
    await expect.poll(() => installBody).toEqual({ engine: 'fasterwhisper', size: 'large-v3-turbo' });

    const job = row.getByTestId('install-job');
    await expect(job).toHaveAttribute('data-stage', 'running');
    await expect(row.getByTestId('install-log')).toContainText('Downloading large-v3-turbo (1.6 GB)');
    await expect(row.getByRole('button', { name: 'Installing…' })).toBeDisabled();

    // The server finishes: the next poll shows it, and the new engine.
    const installed = { ...WHISPER, name: 'local faster-whisper large-v3-turbo', modelId: 'large-v3-turbo' };
    state.overview = {
      ...state.overview,
      engines: [installed, VOXCPM],
      hear: { available: true, model: installed.name, engine: 'fasterwhisper', local: true, reason: null },
      jobs: [{ engine: 'fasterwhisper', size: 'large-v3-turbo', stage: 'done', log: ['Done'], model: installed.name, bound: 'primary', startedAt: Date.now(), finishedAt: Date.now() }],
    };
    await expect(job).toHaveAttribute('data-stage', 'done');
    await expect(job).toContainText('Installed as local faster-whisper large-v3-turbo. It is now the primary.');
    await expect(row.getByTestId('install-log')).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Install' })).toBeEnabled();
    await expect(page.getByTestId('voice-status-stt')).toHaveText('Now: local faster-whisper large-v3-turbo · on this machine');
  });

  test('an install that fails says why', async ({ authenticatedPage: page }) => {
    await stubVoice(page, { overview: overviewOf({ jobs: [{ engine: 'kokoro', stage: 'error', log: ['uv: command not found'], error: 'uv is not installed', startedAt: Date.now(), finishedAt: Date.now() }] }) });
    await page.goto('/settings?tab=voice');
    const row = page.locator('[data-testid="catalog-row"][data-engine="kokoro"]');
    await expect(row.getByTestId('install-error')).toHaveText('The install failed: uv is not installed');
    await expect(row.getByTestId('install-log')).toContainText('uv: command not found');
  });

  test('a voice made from a description is previewed and saved with the description', async ({ authenticatedPage: page }) => {
    await stubVoice(page, { overview: overviewOf() });
    const spoken: Array<Record<string, unknown>> = [];
    await page.route('**/api/voice/speak', (route) => {
      spoken.push(route.request().postDataJSON() as Record<string, unknown>);
      return route.fulfill({ status: 200, contentType: 'audio/wav', headers: { 'X-Speech-Model': encodeURIComponent(VOXCPM.name) }, body: silentWav() });
    });
    let saved: { url: string; body: Record<string, unknown> } | undefined;
    await page.route('**/api/voice/profiles/*', (route) => {
      if (route.request().method() !== 'PUT') return route.fallback();
      saved = { url: route.request().url(), body: route.request().postDataJSON() as Record<string, unknown> };
      return json(route, 200, { profile: { name: 'Calm narrator', instructions: saved.body.instructions, hasClip: true } });
    });
    await page.goto('/settings?tab=voice');

    const voices = page.getByTestId('voice-voices');
    await voices.getByRole('button', { name: 'New voice' }).click();
    const form = page.getByTestId('voice-profile-form');
    // VoxCPM2 offers no preset voices: describing and cloning are the ways.
    await expect(form.getByRole('tab', { name: 'Pick a voice' })).toHaveCount(0);
    await expect(form.getByRole('tab', { name: 'Clone from a clip' })).toBeVisible();
    await form.getByRole('tab', { name: 'Describe it' }).click();
    await form.getByLabel('Name').fill('Calm narrator');
    await form.getByLabel('Describe the voice').fill('A calm woman in her forties, slight Scottish accent');
    await form.getByRole('button', { name: 'Preview' }).click();
    await expect.poll(() => spoken[0]).toMatchObject({ instructions: 'A calm woman in her forties, slight Scottish accent', model: VOXCPM.name });

    // The engine can clone, so the preview can be kept as the voice itself.
    await form.getByLabel('Keep this exact voice').check();
    await expect(form.getByTestId('voice-made-of')).toHaveText('This voice is made of a description + a reference clip.');
    await form.getByLabel('Speak replies in this voice from now on').check();
    await form.getByRole('button', { name: 'Save voice' }).click();

    await expect.poll(() => saved?.url).toContain('/api/voice/profiles/Calm%20narrator');
    expect(saved!.body).toMatchObject({
      instructions: 'A calm woman in her forties, slight Scottish accent',
      refText: spoken[0].text,
      model: VOXCPM.name,
      active: true,
      clip: { mimeType: 'audio/wav' },
    });
    expect(Buffer.from((saved!.body.clip as { data: string }).data, 'base64').equals(silentWav())).toBe(true);
    await expect(form).toHaveCount(0);
  });

  test('an engine with only its own voices offers those, and says what it cannot do', async ({ authenticatedPage: page }) => {
    const kokoro = { ...VOXCPM, name: 'local kokoro', kind: 'kokoro', modelId: 'kokoro', endpoint: null, speech: speech({ voices: ['af_sarah', 'bm_george'] }) };
    await stubVoice(page, { overview: overviewOf({ engines: [WHISPER, kokoro], speak: { available: true, model: kokoro.name, engine: 'kokoro', local: true, reason: null } }), voices: ['af_sarah', 'bm_george'] });
    let saved: Record<string, unknown> | undefined;
    await page.route('**/api/voice/profiles/*', (route) => {
      saved = route.request().postDataJSON() as Record<string, unknown>;
      return json(route, 200, { profile: { name: 'George', voice: 'bm_george', hasClip: false } });
    });
    await page.goto('/settings?tab=voice');
    await page.getByTestId('voice-voices').getByRole('button', { name: 'New voice' }).click();
    const form = page.getByTestId('voice-profile-form');
    await expect(form.getByTestId('voice-ways-limited')).toContainText('local kokoro only speaks in its own voices');
    await expect(form.getByTestId('voice-ways-limited')).toContainText('Your own speech server');
    await expect(form.getByRole('tab')).toHaveText(['Pick a voice']);
    await form.getByLabel('Name').fill('George');
    await form.getByLabel('Voice', { exact: true }).selectOption('bm_george');
    await form.getByRole('button', { name: 'Save voice' }).click();
    await expect.poll(() => saved).toEqual({ voice: 'bm_george', model: 'local kokoro' });
  });

  test('the Speak test plays a sentence and names the engine that spoke it; a failure is shown in the page', async ({ authenticatedPage: page }) => {
    await stubVoice(page, { overview: overviewOf(), profiles: [{ name: 'Calm narrator', instructions: 'calm', hasClip: false }] });
    const requests: Array<Record<string, unknown>> = [];
    let fail = false;
    await page.route('**/api/voice/speak', (route) => {
      requests.push(route.request().postDataJSON() as Record<string, unknown>);
      return fail
        ? json(route, 409, { error: 'No model is bound to the Speech lane.', code: 'capability_not_configured', capability: 'speak' })
        : route.fulfill({ status: 200, contentType: 'audio/wav', headers: { 'X-Speech-Model': encodeURIComponent(VOXCPM.name) }, body: silentWav() });
    });
    const dialogs: string[] = [];
    page.on('dialog', (dialog) => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    await page.goto('/settings?tab=voice');

    const speakTest = page.getByTestId('speak-test');
    await speakTest.getByLabel('Say').fill('Good morning.');
    await speakTest.getByLabel('Voice').selectOption('Calm narrator');
    await speakTest.getByRole('button', { name: 'Play' }).click();
    await expect(speakTest.getByTestId('speak-result')).toContainText('Spoken by speech openbmb/VoxCPM2');
    expect(requests[0]).toEqual({ text: 'Good morning.', profile: 'Calm narrator' });

    // Trying one engine in particular names it.
    await speakTest.getByLabel('Engine').selectOption(VOXCPM.name);
    await speakTest.getByLabel('Voice').selectOption('');
    await speakTest.getByRole('button', { name: 'Play' }).click();
    await expect.poll(() => requests[1]).toEqual({ text: 'Good morning.', model: VOXCPM.name });

    fail = true;
    await speakTest.getByRole('button', { name: 'Play' }).click();
    await expect(speakTest.getByTestId('speak-error')).toHaveText('No model is bound to the Speech lane.');
    await expect(speakTest.getByTestId('speak-result')).toHaveCount(0);
    expect(dialogs).toEqual([]);
  });

  test('conversation settings are saved under their keys', async ({ authenticatedPage: page }) => {
    await stubVoice(page, { overview: overviewOf() });
    const puts: Array<{ key: string; body: unknown }> = [];
    await page.route('**/api/settings/voice.*', (route) => {
      puts.push({ key: decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop() ?? ''), body: route.request().postDataJSON() });
      return json(route, 200, { ok: true });
    });
    await page.goto('/settings?tab=voice');
    await page.getByRole('switch', { name: 'Talking over a reply stops it' }).click();
    await expect.poll(() => puts).toContainEqual({ key: 'voice.bargeIn', body: { value: false } });
    // 700 ms → 1200 ms, in the slider's steps of 50.
    const pause = page.getByLabel(/A pause this long ends your turn/);
    for (let step = 0; step < 10; step++) await pause.press('ArrowRight');
    await expect(page.getByTestId('silence-value')).toHaveText('1.20 s');
    await page.getByTestId('voice-conversation').getByRole('button', { name: 'Save' }).last().click();
    await expect.poll(() => puts).toContainEqual({ key: 'voice.endpointSilenceMs', body: { value: 1200 } });
    await page.getByLabel('Incoming calls').selectOption('allowlist');
    await expect.poll(() => puts).toContainEqual({ key: 'voice.inboundPolicy', body: { value: 'allowlist' } });
    const prompt = page.getByLabel('How Octipus behaves on calls');
    await prompt.fill('  You answer the phone for a bakery.  ');
    await prompt.locator('xpath=..').getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => puts).toContainEqual({ key: 'voice.expertPrompt', body: { value: 'You answer the phone for a bakery.' } });
  });

  test('for Telnyx the call account lists the public key incoming webhooks are verified with', async ({ authenticatedPage: page }) => {
    await stubVoice(page, { overview: overviewOf() });
    await page.route('**/api/settings', (route) => json(route, 200, {
      categories: ['voice'],
      settings: { voice: [{ key: 'voice.telephonyProvider', value: 'telnyx', valueType: 'string', defaultValue: 'disabled', description: 'provider', isSecret: false, category: 'voice' }] },
    }));
    await page.route('**/api/vault', (route) => json(route, 200, { credentials: [{ name: 'telnyx_api_key' }, { name: 'telnyx_connection_id' }] }));
    await page.goto('/settings?tab=voice');
    const account = page.getByTestId('call-credentials');
    await expect(account.getByRole('listitem')).toHaveCount(3);
    const publicKey = account.getByRole('listitem').filter({ hasText: 'telnyx_public_key' });
    await expect(publicKey).toContainText('Missing');
    await expect(publicKey.getByTestId('secret-note-telnyx_public_key')).toHaveText('Required for incoming calls: without it, every call Telnyx announces is refused.');
  });

  test('with the Voice module off, an admin still reaches the page and turns voice on from it', async ({ authenticatedPage: page }) => {
    const { MODULES } = await import('../../src/modules');
    const answer = (voiceOn: boolean) => {
      const modules = MODULES.map((m) => ({ ...m, requiredBy: [], on: m.id !== 'voice' || voiceOn }));
      return { modules, enabled: modules.filter((m) => m.on).map((m) => m.id), capabilities: [] };
    };
    await page.route('**/api/modules', (route) => json(route, 200, answer(false)));
    let turnedOn: unknown;
    await page.route('**/api/modules/enable', (route) => {
      turnedOn = route.request().postDataJSON();
      return json(route, 200, answer(true));
    });
    await stubVoice(page, { overview: overviewOf() });

    await page.goto('/settings');
    await page.getByRole('button', { name: 'Voice & Calls' }).click();
    const off = page.getByTestId('voice-off');
    await expect(off.getByRole('heading', { name: 'Voice is switched off' })).toBeVisible();
    await off.getByRole('button', { name: 'Turn it on' }).click();
    await expect.poll(() => turnedOn).toEqual({ ids: ['voice'] });
    await expect(page.getByTestId('voice-status-stt')).toBeVisible();
  });

  test('someone who is not an admin sees whether voice works and who sets it up', async ({ authenticatedPage: page }) => {
    await page.route('**/api/auth/me', (route) => json(route, 200, { id: 'e2e-user-id', username: 'e2etest', email: 'e2e@test.local', isAdmin: false }));
    await page.addInitScript(() => localStorage.setItem('assistant-user', JSON.stringify({ id: 'e2e-user-id', username: 'e2etest', email: 'e2e@test.local', isAdmin: false })));
    let askedEngines = false;
    await page.route('**/api/voice/engines', (route) => { askedEngines = true; return json(route, 403, { error: 'Admin access required' }); });
    await page.route('**/api/voice/status', (route) => json(route, 200, { sttAvailable: true, sttReason: null, ttsAvailable: false, ttsReason: 'No model is bound to the Speech lane.' }));
    await page.goto('/settings?tab=voice');
    const member = page.getByTestId('voice-member');
    await expect(member).toContainText('Hear (speech to text): on');
    await expect(member).toContainText('Speak (text to speech): off — No model is bound to the Speech lane.');
    await expect(member).toContainText('An admin sets up voice.');
    expect(askedEngines).toBe(false);
  });
});
