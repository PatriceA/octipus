import { test, expect } from './fixtures/auth';
import { stubAllDefaults, json } from './fixtures/api-stubs';

// The media lanes (docs/MEDIA.md, docs/VOICE.md) on the Topics page, and their
// pricing in the model editor.

const lane = (value: string, label: string, kind: string, effectiveModel: string | null, offReason?: string) => ({
  value, label, kind, description: `${label} lane`, effectiveModel, ...(offReason ? { offReason } : {}),
  primaryModel: effectiveModel, backupModel: null, executorModel: null, temperature: null, maxTokens: null,
});

test.describe('media lanes', () => {
  test.beforeEach(async ({ authenticatedPage }) => {
    await stubAllDefaults(authenticatedPage);
  });

  test('the Topics page groups the five media lanes under Media, each with what serves it or why it is off', async ({ authenticatedPage: page }) => {
    await page.route('**/api/topics', (route) => json(route, 200, {
      topics: [
        { ...lane('everyday', 'Everyday', 'text', null), primaryModel: 'gpt-4o' },
        lane('vision', 'Vision', 'vision', 'gpt-4o (default model reads images)'),
        lane('ocr', 'OCR', 'ocr', 'gpt-4o (via vision)'),
        lane('image_generation', 'Image generation', 'image_generation', null, 'No model is bound to the Image generation lane.'),
        lane('transcription', 'Transcription', 'transcription', 'local faster-whisper small'),
        lane('speech', 'Speech', 'speech', null, 'No model is bound to the Speech lane.'),
      ],
    }));
    await page.goto('/topics');
    const media = page.getByTestId('media-lanes');
    await expect(media.getByRole('heading', { name: 'Media' })).toBeVisible();
    for (const name of ['Vision', 'OCR', 'Image generation', 'Transcription', 'Speech']) {
      await expect(media.getByRole('heading', { name, exact: true })).toBeVisible();
    }
    await expect(media.getByRole('heading', { name: 'Everyday' })).toHaveCount(0);
    await expect(page.getByTestId('effective-ocr')).toHaveText('Served by gpt-4o (via vision)');
    await expect(page.getByTestId('effective-image_generation')).toHaveText('Off — No model is bound to the Image generation lane.');
    // Speech engines are added and chosen on the Voice page; the lanes link there.
    for (const direction of ['stt', 'tts']) {
      await expect(media.getByTestId(`speech-engines-${direction}`).getByRole('link', { name: 'Manage speech engines on the Voice page' }))
        .toHaveAttribute('href', '/settings?tab=voice');
    }
    await expect(media.getByRole('button', { name: /^Use/ })).toHaveCount(0);
  });

  test('the speech lanes offer only speech engines of their direction, hide the text-model fields, and show a refused binding', async ({ authenticatedPage: page }) => {
    const engine = (name: string, direction: 'stt' | 'tts', role: 'primary' | 'backup' | null) => ({
      name, direction, kind: 'compatible', modelId: name, endpoint: 'http://gpu-box:8000/v1', apiKeyRef: null, role, local: true, available: true, reason: null,
      speech: { voices: [], instructions: 'none', cloning: false, speed: false, streams: false, sampleRate: null, formats: [], realtime: null, upload: 'any', device: null },
    });
    await page.route('**/api/topics', (route) => json(route, 200, {
      topics: [
        { ...lane('everyday', 'Everyday', 'text', null), primaryModel: 'gpt-4o' },
        lane('transcription', 'Transcription', 'transcription', 'whisper turbo'),
        lane('speech', 'Speech', 'speech', null, 'No model is bound to the Speech lane.'),
      ],
    }));
    await page.route('**/api/models', (route) => json(route, 200, { models: [
      { id: 'm1', name: 'gpt-4o', provider: 'openai', modelId: 'gpt-4o', isEnabled: true, topics: ['everyday'] },
    ] }));
    await page.route('**/api/voice/engines', (route) => json(route, 200, {
      hear: { available: true, model: 'whisper turbo', engine: 'compatible', local: true, reason: null },
      speak: { available: false, model: null, engine: null, local: false, reason: 'No model is bound to the Speech lane.' },
      engines: [engine('whisper turbo', 'stt', 'primary'), engine('parakeet', 'stt', null), engine('voxcpm', 'tts', null)],
      catalog: [], jobs: [], host: { uv: true, ffmpeg: true },
    }));
    let binding: unknown;
    await page.route('**/api/topics/transcription/binding', (route) => {
      binding = route.request().postDataJSON();
      return json(route, 400, { error: 'gpt-4o is not a speech-to-text engine.' });
    });
    await page.goto('/topics');

    const hear = page.getByTestId('topic-transcription');
    const primary = hear.getByLabel('Primary');
    await expect(primary.locator('option')).toHaveText(['— none —', 'whisper turbo', 'parakeet']);
    await expect(hear.getByLabel('Backup').locator('option')).toHaveText(['— none —', 'whisper turbo', 'parakeet']);
    await expect(page.getByTestId('topic-speech').getByLabel('Primary').locator('option')).toHaveText(['— none —', 'voxcpm']);
    for (const field of ['Executor', 'Temp', 'Max tok']) await expect(hear.getByText(field, { exact: true })).toHaveCount(0);
    // A text lane keeps them.
    await expect(page.getByTestId('topic-everyday').getByText('Executor', { exact: true })).toBeVisible();

    await hear.getByLabel('Backup').selectOption('parakeet');
    await hear.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => binding).toEqual({ primaryModel: 'whisper turbo', backupModel: 'parakeet' });
    await expect(page.getByTestId('save-error-transcription')).toHaveText('gpt-4o is not a speech-to-text engine.');
  });

  test('the model editor shows per-image pricing for an image model, keeps the others under Media pricing, and saves them', async ({ authenticatedPage: page }) => {
    const imageModel = {
      id: 'img-1', name: 'openai gpt-image-1', provider: 'openai', modelId: 'gpt-image-1', isEnabled: true, isDefault: false,
      supportsVision: false, supportsTools: false, supportsStreaming: false, contextWindow: 8192, maxTokens: 4096,
      topics: ['image_generation'], priority: 50, costPerInputToken: 0, costPerOutputToken: 0, metadata: {},
    };
    let saved: Record<string, unknown> | undefined;
    await page.route('**/api/models', (route) => json(route, 200, { models: [imageModel] }));
    await page.route('**/api/models/openai%20gpt-image-1', async (route) => {
      if (route.request().method() !== 'PATCH') return route.fallback();
      saved = route.request().postDataJSON() as Record<string, unknown>;
      return json(route, 200, imageModel);
    });

    await page.goto('/models');
    await page.getByTitle('Edit model').click();
    const perImage = page.getByTestId('pricing-perImage');
    await expect(perImage).toBeVisible();
    const more = page.getByTestId('media-pricing');
    await expect(more.getByTestId('pricing-perImage')).toHaveCount(0);
    await expect(more.getByTestId('pricing-perAudioMinute')).toBeHidden();
    await more.locator('summary').click();
    await expect(more.getByTestId('pricing-perMillionChars')).toBeVisible();

    await perImage.fill('0.04');
    await page.getByRole('button', { name: 'Save Changes' }).click();
    await expect.poll(() => saved).toBeTruthy();
    expect(saved).toMatchObject({ metadata: { pricing: { perImage: 0.04 } } });
  });
});
