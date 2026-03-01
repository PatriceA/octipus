import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { ScreenshotCapture } from './screenshot';

// Mock Playwright
const mockPage = {
  goto: mock(() => Promise.resolve()),
  screenshot: mock(() => Promise.resolve(Buffer.from('fake-image'))),
  viewportSize: mock(() => ({ width: 1920, height: 1080 })),
  url: mock(() => 'https://example.com'),
  click: mock(() => Promise.resolve()),
  fill: mock(() => Promise.resolve()),
  content: mock(() => Promise.resolve('<html></html>')),
  setViewportSize: mock(() => Promise.resolve()),
  waitForSelector: mock(() => Promise.resolve({ screenshot: () => Promise.resolve(Buffer.from('element-screenshot')) })),
  waitForLoadState: mock(() => Promise.resolve()),
  close: mock(() => Promise.resolve()),
  $$: mock(() => Promise.resolve([])),
  evaluate: mock(() => Promise.resolve()),
};

const mockContext = {
  newPage: mock(() => Promise.resolve(mockPage)),
  close: mock(() => Promise.resolve()),
};

const mockBrowser = {
  newContext: mock(() => Promise.resolve(mockContext)),
  close: mock(() => Promise.resolve()),
};

// Mock chromium launcher
const mockChromium = {
  launch: mock(() => Promise.resolve(mockBrowser)),
};

describe('ScreenshotCapture', () => {
  let capture: ScreenshotCapture;

  beforeEach(() => {
    // Reset mocks
    Object.values(mockPage).forEach(m => m.mockClear?.());
    Object.values(mockContext).forEach(m => m.mockClear?.());
    Object.values(mockBrowser).forEach(m => m.mockClear?.());

    capture = new ScreenshotCapture('chromium', true);
    // Inject mock browser
    (capture as any).browser = mockBrowser;
    (capture as any).context = mockContext;
    (capture as any).page = mockPage;
  });

  afterEach(async () => {
    await capture.close();
  });

  describe('navigate', () => {
    test('navigates to URL', async () => {
      await capture.navigate('https://example.com');

      expect(mockPage.goto).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({ waitUntil: 'networkidle' })
      );
    });

    test('supports different wait conditions', async () => {
      await capture.navigate('https://example.com', 'domcontentloaded');

      expect(mockPage.goto).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({ waitUntil: 'domcontentloaded' })
      );
    });
  });

  describe('capture', () => {
    test('captures full page screenshot', async () => {
      const result = await capture.capture({ fullPage: true });

      expect(mockPage.screenshot).toHaveBeenCalledWith(
        expect.objectContaining({ fullPage: true })
      );
      expect(result.image).toBeInstanceOf(Buffer);
      expect(result.width).toBe(1920);
      expect(result.height).toBe(1080);
    });

    test('captures viewport screenshot', async () => {
      const result = await capture.capture();

      expect(mockPage.screenshot).toHaveBeenCalledWith(
        expect.objectContaining({ fullPage: false })
      );
    });

    test('captures element screenshot', async () => {
      const mockElement = {
        screenshot: mock(() => Promise.resolve(Buffer.from('element-image'))),
      };
      mockPage.waitForSelector.mockResolvedValueOnce(mockElement);

      const result = await capture.capture({ selector: '#target' });

      expect(mockPage.waitForSelector).toHaveBeenCalledWith('#target', expect.any(Object));
      expect(result.image).toBeInstanceOf(Buffer);
    });

    test('captures JPEG with quality', async () => {
      await capture.capture({ format: 'jpeg', quality: 80 });

      expect(mockPage.screenshot).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'jpeg', quality: 80 })
      );
    });

    test('includes URL in result', async () => {
      mockPage.url.mockReturnValue('https://captured.example.com');

      const result = await capture.capture();

      expect(result.url).toBe('https://captured.example.com');
    });

    test('includes timestamp in result', async () => {
      const before = Date.now();
      const result = await capture.capture();
      const after = Date.now();

      expect(result.timestamp).toBeGreaterThanOrEqual(before);
      expect(result.timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe('captureWithElements', () => {
    test('extracts element information', async () => {
      const mockElements = [
        {
          evaluate: mock((fn: any) => fn({ tagName: 'button', className: 'btn', id: 'submit', attributes: [] })),
          textContent: mock(() => Promise.resolve('Submit')),
          boundingBox: mock(() => Promise.resolve({ x: 100, y: 200, width: 80, height: 30 })),
          isVisible: mock(() => Promise.resolve(true)),
          isEnabled: mock(() => Promise.resolve(true)),
        },
      ];

      mockPage.$$.mockResolvedValue(mockElements as any);

      const result = await capture.captureWithElements();

      expect(result.elements).toBeDefined();
      expect(result.elements!.length).toBeGreaterThan(0);
    });
  });

  describe('interactions', () => {
    test('clicks element', async () => {
      await capture.click('#button');

      expect(mockPage.click).toHaveBeenCalledWith('#button');
    });

    test('types text into element', async () => {
      await capture.type('#input', 'Hello World');

      expect(mockPage.fill).toHaveBeenCalledWith('#input', 'Hello World');
    });

    test('gets page content', async () => {
      mockPage.content.mockResolvedValue('<html><body>Test</body></html>');

      const content = await capture.getContent();

      expect(content).toBe('<html><body>Test</body></html>');
    });

    test('sets viewport size', async () => {
      await capture.setViewport(1280, 720);

      expect(mockPage.setViewportSize).toHaveBeenCalledWith({ width: 1280, height: 720 });
    });

    test('waits for selector', async () => {
      await capture.waitForSelector('.loading-complete');

      expect(mockPage.waitForSelector).toHaveBeenCalledWith('.loading-complete', expect.any(Object));
    });
  });

  describe('cleanup', () => {
    test('closes browser on close()', async () => {
      await capture.close();

      expect(mockPage.close).toHaveBeenCalled();
      expect(mockContext.close).toHaveBeenCalled();
      expect(mockBrowser.close).toHaveBeenCalled();
    });
  });
});
