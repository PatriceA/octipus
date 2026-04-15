import { BaseTool, createParameterSchema, type ToolAvailability } from '../base-tool';
import type { ToolManifest } from '@/core/types';
import { getLiteLLMClient } from '@/models/litellm-client';
import { getModelRegistry } from '@/models/model-registry';
import { getBrowserBridge } from '@/api/browser-bridge';
import { ScreenshotCapture, type BrowserType, type ScreenshotResult } from '@/visual/screenshot';
import { VisualAnalyzer } from '@/visual/analyzer';

type CaptureBackend = 'playwright' | 'browser-ext';

function isPlaywrightMissingError(err: unknown): boolean {
  const msg = (err as Error)?.message || '';
  return msg.includes("Executable doesn't exist") || msg.includes('playwright install');
}

async function playwrightUsable(browserType: BrowserType): Promise<boolean> {
  const cap = new ScreenshotCapture(browserType, true);
  try {
    await cap.init();
    return true;
  } catch (err) {
    if (isPlaywrightMissingError(err)) return false;
    return false;
  } finally {
    await cap.close().catch(() => {});
  }
}

export class VisualTool extends BaseTool {
  readonly id = 'visual';
  readonly name = 'Visual Analysis';
  readonly version = '1.0.0';
  readonly description =
    'Capture and analyze web pages with a vision model. Returns UI elements, visual/functional/accessibility issues, and suggestions. Useful for QA and UI testing.';

  async checkAvailability(): Promise<ToolAvailability> {
    const m = await getModelRegistry().getModelForTopic('vision');
    if (!m) {
      return {
        available: false,
        reason: 'No model mapped to topic "vision" — assign one in the Models page',
      };
    }
    // Need at least one capture backend.
    const extConnected = getBrowserBridge().connected;
    const pwOk = extConnected ? true : await playwrightUsable('chromium');
    if (!pwOk && !extConnected) {
      return {
        available: false,
        reason: 'No capture backend available. Install Playwright browsers (`bunx playwright install`) or connect the Browser Extension.',
      };
    }
    return { available: true };
  }

  getManifest(): ToolManifest {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      permissions: [
        { action: 'analyze', description: 'Capture and visually analyze a web page', defaultLevel: 'ALLOW' },
      ],
      tools: [
        {
          name: 'analyze_page',
          description: 'Navigate to a URL, capture a screenshot, and analyze the UI with a vision model.',
          parameters: {
            url: { type: 'string', description: 'Page URL', required: true },
            context: { type: 'string', description: 'Optional context about what to look for' },
            fullPage: { type: 'boolean', description: 'Capture the entire scrollable page (default: false)' },
            browserType: { type: 'string', description: 'chromium | firefox | webkit (default: chromium)' },
          },
          returns: 'AnalysisResult: description, elements, issues, suggestions, accessibility',
        },
        {
          name: 'compare_pages',
          description: 'Capture two URLs and compare their UIs; returns similarity, differences, and a summary.',
          parameters: {
            urlA: { type: 'string', description: 'First URL', required: true },
            urlB: { type: 'string', description: 'Second URL', required: true },
            browserType: { type: 'string', description: 'chromium | firefox | webkit (default: chromium)' },
          },
          returns: 'ComparisonResult: similarity, differences, summary',
        },
      ],
    };
  }

  private async resolveVisionModel(): Promise<string> {
    const m = await getModelRegistry().getModelForTopic('vision');
    if (!m) {
      throw new Error('No model mapped to topic "vision". Assign one in the Models page.');
    }
    return m.modelId;
  }

  /**
   * Capture one or more URLs. Tries Playwright first; on missing-browser error,
   * falls back to the Browser Extension bridge. Throws if neither works.
   */
  private async captureUrls(
    urls: Array<{ url: string; fullPage?: boolean }>,
    browserType: BrowserType,
  ): Promise<{ backend: CaptureBackend; shots: ScreenshotResult[] }> {
    // Try Playwright
    const cap = new ScreenshotCapture(browserType, true);
    try {
      await cap.init();
      const shots: ScreenshotResult[] = [];
      for (const { url, fullPage } of urls) {
        await cap.navigate(url);
        shots.push(await cap.capture({ fullPage: !!fullPage }));
      }
      await cap.close().catch(() => {});
      return { backend: 'playwright', shots };
    } catch (err) {
      await cap.close().catch(() => {});
      if (!isPlaywrightMissingError(err)) throw err;
    }

    // Fall back to Browser Extension
    const bridge = getBrowserBridge();
    if (!bridge.connected) {
      throw new Error(
        'Visual capture unavailable: Playwright browsers not installed (run `bunx playwright install`) and the Browser Extension is not connected.',
      );
    }

    const shots: ScreenshotResult[] = [];
    for (const { url } of urls) {
      await bridge.sendCommand('navigate', { url });
      // Small settle wait; extension screenshot doesn't wait on load
      await new Promise((r) => setTimeout(r, 1200));
      const res = (await bridge.sendCommand('screenshot')) as {
        image: string; tabId: number; url: string; title: string;
      };
      // image is base64 PNG, possibly with data URL prefix
      const b64 = res.image.replace(/^data:image\/\w+;base64,/, '');
      const buf = Buffer.from(b64, 'base64');
      shots.push({
        image: buf,
        format: 'png',
        width: 0,
        height: 0,
        url: res.url,
        timestamp: Date.now(),
      });
    }
    return { backend: 'browser-ext', shots };
  }

  protected async registerTools(): Promise<void> {
    this.registerTool(
      'analyze_page',
      'Navigate to a URL, take a screenshot, and analyze the UI with the assigned vision model. Returns elements, visual/functional/accessibility issues, and improvement suggestions.',
      createParameterSchema({
        url: { type: 'string', description: 'Page URL to analyze', required: true },
        context: { type: 'string', description: 'Optional context describing what to check for (e.g. "verify the login button is prominent")' },
        fullPage: { type: 'boolean', description: 'Capture the entire scrollable page', default: false },
        browserType: { type: 'string', description: 'chromium | firefox | webkit', default: 'chromium' },
      }),
      async (args) => {
        const url = args.url as string;
        const context = args.context as string | undefined;
        const fullPage = Boolean(args.fullPage);
        const browserType = (args.browserType as BrowserType) || 'chromium';

        const modelId = await this.resolveVisionModel();
        const analyzer = new VisualAnalyzer(getLiteLLMClient(), modelId);
        const { backend, shots } = await this.captureUrls([{ url, fullPage }], browserType);
        const shot = shots[0];
        const result = await analyzer.analyze(shot, context);
        return {
          url: shot.url,
          width: shot.width,
          height: shot.height,
          backend,
          ...result,
        };
      },
      { requiresPermission: true, permissionAction: 'analyze' },
    );

    this.registerTool(
      'compare_pages',
      'Capture screenshots of two URLs and compare them with the vision model. Use for regression checks, A/B comparison, or before/after validation.',
      createParameterSchema({
        urlA: { type: 'string', description: 'First URL', required: true },
        urlB: { type: 'string', description: 'Second URL', required: true },
        browserType: { type: 'string', description: 'chromium | firefox | webkit', default: 'chromium' },
      }),
      async (args) => {
        const urlA = args.urlA as string;
        const urlB = args.urlB as string;
        const browserType = (args.browserType as BrowserType) || 'chromium';

        const modelId = await this.resolveVisionModel();
        const analyzer = new VisualAnalyzer(getLiteLLMClient(), modelId);
        const { backend, shots } = await this.captureUrls(
          [{ url: urlA }, { url: urlB }],
          browserType,
        );
        const result = await analyzer.compare(shots[0], shots[1]);
        return { backend, ...result };
      },
      { requiresPermission: true, permissionAction: 'analyze' },
    );
  }
}

export const visualTool = new VisualTool();
