import { BaseTool, createParameterSchema } from '../base-tool';
import type { ToolManifest } from '@/core/types';
import { getBrowserBridge } from '@/api/browser-bridge';

export class BrowserExtTool extends BaseTool {
  readonly id = 'browser-ext';
  readonly name = 'Browser Extension';
  readonly version = '1.0.0';
  readonly description = 'Interact with the user\'s real browser via the Assistant Chrome extension. Uses existing cookies and sessions — no bot detection.';

  getManifest(): ToolManifest {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      permissions: [
        { action: 'navigate', description: 'Navigate browser tabs', defaultLevel: 'ASK' },
        { action: 'interact', description: 'Click and fill on pages', defaultLevel: 'ASK' },
        { action: 'screenshot', description: 'Take browser screenshots', defaultLevel: 'ALLOW' },
        { action: 'extract', description: 'Extract page content', defaultLevel: 'ALLOW' },
        { action: 'evaluate', description: 'Execute JavaScript in page', defaultLevel: 'ASK', dangerous: true },
        { action: 'cookies', description: 'Read browser cookies', defaultLevel: 'ASK', dangerous: true },
      ],
      tools: [
        { name: 'navigate', description: 'Navigate the active tab to a URL', parameters: { url: { type: 'string', description: 'URL to navigate to', required: true } }, returns: 'Page URL and title after navigation' },
        { name: 'screenshot', description: 'Take a screenshot of the active tab', parameters: {}, returns: 'Base64 PNG screenshot' },
        { name: 'extract_content', description: 'Extract text, links, and forms from the current page', parameters: { selector: { type: 'string', description: 'CSS selector to scope extraction' } }, returns: 'Page text, links, forms, and metadata' },
        { name: 'click', description: 'Click an element by CSS selector', parameters: { selector: { type: 'string', description: 'CSS selector', required: true } }, returns: 'Click result' },
        { name: 'fill', description: 'Fill an input field with a value', parameters: { selector: { type: 'string', description: 'CSS selector', required: true }, value: { type: 'string', description: 'Value to fill', required: true } }, returns: 'Fill result' },
        { name: 'evaluate', description: 'Execute JavaScript in the page context', parameters: { expression: { type: 'string', description: 'JavaScript expression', required: true } }, returns: 'Evaluation result' },
        { name: 'get_tabs', description: 'List all open browser tabs', parameters: {}, returns: 'List of tabs with URL and title' },
        { name: 'get_cookies', description: 'Get cookies for a domain', parameters: { domain: { type: 'string', description: 'Domain to get cookies for', required: true } }, returns: 'List of cookies' },
      ],
    };
  }

  protected async registerTools(): Promise<void> {
    const bridge = getBrowserBridge();

    this.registerTool(
      'navigate',
      'Navigate the active browser tab to a URL. Uses the user\'s real browser with existing sessions.',
      createParameterSchema({
        url: { type: 'string', description: 'URL to navigate to', required: true },
        tabId: { type: 'number', description: 'Specific tab ID (optional, uses active tab if omitted)' },
      }),
      async (args) => {
        return bridge.sendCommand('navigate', {
          url: args.url as string,
          tabId: args.tabId as number | undefined,
        });
      },
      { permissionAction: 'navigate' },
    );

    this.registerTool(
      'screenshot',
      'Take a screenshot of the active browser tab. Returns a base64 PNG image.',
      createParameterSchema({
        tabId: { type: 'number', description: 'Specific tab ID (optional, uses active tab if omitted)' },
      }),
      async (args) => {
        const result = await bridge.sendCommand('screenshot', {
          tabId: args.tabId as number | undefined,
        }) as { image: string; tabId: number; url: string; title: string };
        return {
          tabId: result.tabId,
          url: result.url,
          title: result.title,
          image: result.image,
        };
      },
      { permissionAction: 'screenshot' },
    );

    this.registerTool(
      'extract_content',
      'Extract text content, links, and forms from the current page. Optionally scope to a CSS selector.',
      createParameterSchema({
        selector: { type: 'string', description: 'CSS selector to scope extraction (optional)' },
        tabId: { type: 'number', description: 'Specific tab ID (optional)' },
      }),
      async (args) => {
        return bridge.sendCommand('extract_content', {
          selector: args.selector as string | undefined,
          tabId: args.tabId as number | undefined,
        });
      },
      { permissionAction: 'extract' },
    );

    this.registerTool(
      'click',
      'Click an element on the page by CSS selector.',
      createParameterSchema({
        selector: { type: 'string', description: 'CSS selector of the element to click', required: true },
        tabId: { type: 'number', description: 'Specific tab ID (optional)' },
      }),
      async (args) => {
        return bridge.sendCommand('click', {
          selector: args.selector as string,
          tabId: args.tabId as number | undefined,
        });
      },
      { permissionAction: 'interact' },
    );

    this.registerTool(
      'fill',
      'Fill an input field with a value. Dispatches input and change events for framework compatibility.',
      createParameterSchema({
        selector: { type: 'string', description: 'CSS selector of the input to fill', required: true },
        value: { type: 'string', description: 'Value to fill into the input', required: true },
        tabId: { type: 'number', description: 'Specific tab ID (optional)' },
      }),
      async (args) => {
        return bridge.sendCommand('fill', {
          selector: args.selector as string,
          value: args.value as string,
          tabId: args.tabId as number | undefined,
        });
      },
      { permissionAction: 'interact' },
    );

    this.registerTool(
      'evaluate',
      'Execute a JavaScript expression in the page context and return the result.',
      createParameterSchema({
        expression: { type: 'string', description: 'JavaScript expression to evaluate', required: true },
        tabId: { type: 'number', description: 'Specific tab ID (optional)' },
      }),
      async (args) => {
        return bridge.sendCommand('evaluate', {
          expression: args.expression as string,
          tabId: args.tabId as number | undefined,
        });
      },
      { permissionAction: 'evaluate' },
    );

    this.registerTool(
      'get_tabs',
      'List all open browser tabs with their URLs and titles.',
      createParameterSchema({}),
      async () => {
        return bridge.sendCommand('get_tabs');
      },
      { permissionAction: 'extract' },
    );

    this.registerTool(
      'get_cookies',
      'Get cookies for a specific domain from the user\'s browser.',
      createParameterSchema({
        domain: { type: 'string', description: 'Domain to get cookies for (e.g., "github.com")', required: true },
      }),
      async (args) => {
        return bridge.sendCommand('get_cookies', {
          domain: args.domain as string,
        });
      },
      { permissionAction: 'cookies' },
    );
  }
}

export const browserExtTool = new BrowserExtTool();
