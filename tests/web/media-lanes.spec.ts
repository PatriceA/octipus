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
    // The speech engines can still be picked in one click.
    await expect(media.getByTestId('speech-engines-stt')).toBeVisible();
    await expect(media.getByTestId('speech-engines-tts')).toBeVisible();
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
