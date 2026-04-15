import { BaseTool, createParameterSchema } from '../base-tool';
import type { ToolManifest } from '@/core/types';
import { getBrowserBridge } from '@/api/browser-bridge';
import { toolLogger } from '@/utils/logger';

// Tabs opened by an agent via new_tab — closed when the agent finishes.
const agentTabs = new Map<string, Set<number>>();

function trackTab(agentId: string, tabId: number): void {
  let set = agentTabs.get(agentId);
  if (!set) { set = new Set(); agentTabs.set(agentId, set); }
  set.add(tabId);
}

function untrackTab(agentId: string, tabId: number): void {
  const set = agentTabs.get(agentId);
  if (!set) return;
  set.delete(tabId);
  if (set.size === 0) agentTabs.delete(agentId);
}

export async function closeAgentTabs(agentId: string): Promise<void> {
  const set = agentTabs.get(agentId);
  if (!set || set.size === 0) return;
  agentTabs.delete(agentId);
  const bridge = getBrowserBridge();
  for (const tabId of set) {
    try {
      await bridge.sendCommand('close_tab', { tabId });
    } catch (err) {
      toolLogger.debug({ err, agentId, tabId }, 'Failed to auto-close browser tab');
    }
  }
}

export class BrowserExtTool extends BaseTool {
  readonly id = 'browser-ext';
  readonly name = 'Browser Extension';
  readonly version = '2.0.0';
  readonly description = 'Interact with the user\'s real browser via the Assistant Chrome extension. Full browser control: navigate, click, type, screenshot, tabs, cookies, storage, network, console, and more. Uses existing cookies and sessions — no bot detection.';

  getManifest(): ToolManifest {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      permissions: [
        { action: 'navigate', description: 'Navigate your real browser tabs to URLs via the Chrome extension', defaultLevel: 'ASK' },
        { action: 'interact', description: 'Click, hover, type, scroll, select, drag, and press keys in your real browser', defaultLevel: 'ASK' },
        { action: 'screenshot', description: 'Capture screenshots of your real browser tabs', defaultLevel: 'ALLOW' },
        { action: 'extract', description: 'Extract text, links, forms, console logs, and network requests', defaultLevel: 'ALLOW' },
        { action: 'evaluate', description: 'Run arbitrary JavaScript in your real browser page context', defaultLevel: 'ASK', dangerous: true },
        { action: 'cookies', description: 'Read/write cookies and localStorage/sessionStorage', defaultLevel: 'ASK', dangerous: true },
        { action: 'tabs', description: 'Create, close, and switch browser tabs', defaultLevel: 'ASK' },
      ],
      tools: [
        // Navigation & tabs
        { name: 'navigate', description: 'Navigate the active tab to a URL', parameters: { url: { type: 'string', description: 'URL', required: true } }, returns: 'Page URL and title' },
        { name: 'new_tab', description: 'Open a new browser tab', parameters: { url: { type: 'string', description: 'URL to open' } }, returns: 'New tab info' },
        { name: 'close_tab', description: 'Close a browser tab', parameters: { tabId: { type: 'number', description: 'Tab ID to close' } }, returns: 'Confirmation' },
        { name: 'select_tab', description: 'Switch to a specific tab', parameters: { tabId: { type: 'number', description: 'Tab ID', required: true } }, returns: 'Tab info' },
        { name: 'get_tabs', description: 'List all open browser tabs', parameters: {}, returns: 'List of tabs' },
        // Screenshots & content
        { name: 'screenshot', description: 'Take a screenshot of the active tab', parameters: {}, returns: 'Base64 PNG screenshot' },
        { name: 'extract_content', description: 'Extract text, links, and forms from the page', parameters: { selector: { type: 'string', description: 'CSS selector scope' } }, returns: 'Page content' },
        // Interactions
        { name: 'click', description: 'Click an element by CSS selector', parameters: { selector: { type: 'string', description: 'CSS selector', required: true } }, returns: 'Click result' },
        { name: 'fill', description: 'Fill an input field', parameters: { selector: { type: 'string', description: 'CSS selector', required: true }, value: { type: 'string', description: 'Value', required: true } }, returns: 'Fill result' },
        { name: 'select', description: 'Select a dropdown option', parameters: { selector: { type: 'string', description: 'CSS selector', required: true }, value: { type: 'string', description: 'Option value or text', required: true } }, returns: 'Selected option' },
        { name: 'hover', description: 'Hover over an element', parameters: { selector: { type: 'string', description: 'CSS selector', required: true } }, returns: 'Hover result' },
        { name: 'press_key', description: 'Press a keyboard key', parameters: { key: { type: 'string', description: 'Key name (Enter, Tab, Escape, etc.)', required: true } }, returns: 'Key press result' },
        { name: 'scroll', description: 'Scroll the page', parameters: { direction: { type: 'string', description: 'up/down/left/right/top/bottom' } }, returns: 'Scroll position' },
        { name: 'drag', description: 'Drag element to target', parameters: { sourceSelector: { type: 'string', description: 'Source CSS selector', required: true }, targetSelector: { type: 'string', description: 'Target CSS selector', required: true } }, returns: 'Drag result' },
        // Waiting & debugging
        { name: 'wait_for', description: 'Wait for element or text to appear', parameters: { selector: { type: 'string', description: 'CSS selector' }, text: { type: 'string', description: 'Text to wait for' } }, returns: 'Wait result' },
        { name: 'highlight', description: 'Highlight an element for debugging', parameters: { selector: { type: 'string', description: 'CSS selector', required: true } }, returns: 'Highlight result' },
        // State
        { name: 'evaluate', description: 'Execute JavaScript in the page', parameters: { expression: { type: 'string', description: 'JS expression', required: true } }, returns: 'Eval result' },
        { name: 'get_cookies', description: 'Get cookies for a domain', parameters: { domain: { type: 'string', description: 'Domain', required: true } }, returns: 'Cookies' },
        { name: 'set_cookies', description: 'Set a cookie', parameters: { name: { type: 'string', description: 'Cookie name', required: true }, value: { type: 'string', description: 'Cookie value', required: true }, url: { type: 'string', description: 'URL for the cookie', required: true } }, returns: 'Set result' },
        { name: 'get_storage', description: 'Read localStorage or sessionStorage', parameters: { storageType: { type: 'string', description: 'local or session' } }, returns: 'Storage entries' },
        { name: 'set_storage', description: 'Write to localStorage or sessionStorage', parameters: { key: { type: 'string', description: 'Key', required: true }, value: { type: 'string', description: 'Value', required: true } }, returns: 'Set result' },
        // Monitoring
        { name: 'get_console', description: 'Get captured console logs', parameters: { level: { type: 'string', description: 'Filter by level: log, warn, error, info' } }, returns: 'Console entries' },
        { name: 'get_network', description: 'Get captured network requests', parameters: { filter: { type: 'string', description: 'Filter by URL or type' } }, returns: 'Network entries' },
        // Dialogs
        { name: 'handle_dialog', description: 'Set handler for next alert/confirm/prompt', parameters: { action: { type: 'string', description: 'accept or dismiss', required: true } }, returns: 'Handler status' },
      ],
    };
  }

  protected async registerTools(): Promise<void> {
    const bridge = getBrowserBridge();

    // ── Navigation & Tabs ──

    this.registerTool(
      'navigate',
      'Navigate the active browser tab to a URL. Uses the user\'s real browser with existing sessions.',
      createParameterSchema({
        url: { type: 'string', description: 'URL to navigate to', required: true },
        tabId: { type: 'number', description: 'Specific tab ID (optional, uses active tab if omitted)' },
      }),
      async (args) => bridge.sendCommand('navigate', {
        url: args.url as string,
        tabId: args.tabId as number | undefined,
      }),
      { permissionAction: 'navigate' },
    );

    this.registerTool(
      'new_tab',
      'Open a new browser tab, optionally navigating to a URL.',
      createParameterSchema({
        url: { type: 'string', description: 'URL to open (optional, defaults to blank tab)' },
        active: { type: 'boolean', description: 'Whether to focus the new tab (default: true)' },
      }),
      async (args, context) => {
        const result = await bridge.sendCommand('new_tab', {
          url: args.url as string | undefined,
          active: args.active as boolean | undefined,
        }) as { tabId?: number; url?: string; title?: string };
        if (context?.id && typeof result?.tabId === 'number') {
          trackTab(context.id, result.tabId);
        }
        return result;
      },
      { permissionAction: 'tabs' },
    );

    this.registerTool(
      'close_tab',
      'Close a browser tab. Closes the active tab if no tabId specified.',
      createParameterSchema({
        tabId: { type: 'number', description: 'Tab ID to close (optional, closes active tab)' },
      }),
      async (args, context) => {
        const tabId = args.tabId as number | undefined;
        const result = await bridge.sendCommand('close_tab', { tabId });
        if (context?.id && typeof tabId === 'number') {
          untrackTab(context.id, tabId);
        }
        return result;
      },
      { permissionAction: 'tabs' },
    );

    this.registerTool(
      'select_tab',
      'Switch to a specific browser tab by its ID. Use get_tabs to find tab IDs.',
      createParameterSchema({
        tabId: { type: 'number', description: 'Tab ID to switch to', required: true },
      }),
      async (args) => bridge.sendCommand('select_tab', {
        tabId: args.tabId as number,
      }),
      { permissionAction: 'tabs' },
    );

    this.registerTool(
      'get_tabs',
      'List all open browser tabs with their URLs, titles, and IDs.',
      createParameterSchema({}),
      async () => bridge.sendCommand('get_tabs'),
      { permissionAction: 'extract' },
    );

    // ── Screenshots & Content ──

    this.registerTool(
      'screenshot',
      'Take a screenshot of the active browser tab. Returns a base64 PNG image.',
      createParameterSchema({
        tabId: { type: 'number', description: 'Specific tab ID (optional)' },
      }),
      async (args) => {
        const result = await bridge.sendCommand('screenshot', {
          tabId: args.tabId as number | undefined,
        }) as { image: string; tabId: number; url: string; title: string };
        return { tabId: result.tabId, url: result.url, title: result.title, image: result.image };
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
      async (args) => bridge.sendCommand('extract_content', {
        selector: args.selector as string | undefined,
        tabId: args.tabId as number | undefined,
      }),
      { permissionAction: 'extract' },
    );

    // ── Element Interactions ──

    this.registerTool(
      'click',
      'Click an element on the page by CSS selector. Supports double-click.',
      createParameterSchema({
        selector: { type: 'string', description: 'CSS selector of the element to click', required: true },
        doubleClick: { type: 'boolean', description: 'Double-click instead of single click' },
        tabId: { type: 'number', description: 'Specific tab ID (optional)' },
      }),
      async (args) => bridge.sendCommand('click', {
        selector: args.selector as string,
        doubleClick: args.doubleClick as boolean | undefined,
        tabId: args.tabId as number | undefined,
      }),
      { permissionAction: 'interact' },
    );

    this.registerTool(
      'fill',
      'Fill an input field with a value. Dispatches input and change events for React/Vue/Angular compatibility.',
      createParameterSchema({
        selector: { type: 'string', description: 'CSS selector of the input to fill', required: true },
        value: { type: 'string', description: 'Value to fill into the input', required: true },
        tabId: { type: 'number', description: 'Specific tab ID (optional)' },
      }),
      async (args) => bridge.sendCommand('fill', {
        selector: args.selector as string,
        value: args.value as string,
        tabId: args.tabId as number | undefined,
      }),
      { permissionAction: 'interact' },
    );

    this.registerTool(
      'select',
      'Select an option from a dropdown <select> element by value or visible text.',
      createParameterSchema({
        selector: { type: 'string', description: 'CSS selector of the <select> element', required: true },
        value: { type: 'string', description: 'Option value or visible text to select', required: true },
        tabId: { type: 'number', description: 'Specific tab ID (optional)' },
      }),
      async (args) => bridge.sendCommand('select', {
        selector: args.selector as string,
        value: args.value as string,
        tabId: args.tabId as number | undefined,
      }),
      { permissionAction: 'interact' },
    );

    this.registerTool(
      'hover',
      'Hover over an element by CSS selector. Triggers mouseenter, mouseover, and mousemove events.',
      createParameterSchema({
        selector: { type: 'string', description: 'CSS selector of the element to hover', required: true },
        tabId: { type: 'number', description: 'Specific tab ID (optional)' },
      }),
      async (args) => bridge.sendCommand('hover', {
        selector: args.selector as string,
        tabId: args.tabId as number | undefined,
      }),
      { permissionAction: 'interact' },
    );

    this.registerTool(
      'press_key',
      'Press a keyboard key. Supports named keys (Enter, Tab, Escape, Backspace, ArrowDown, etc.) and characters. Supports Ctrl/Shift/Alt/Meta modifiers.',
      createParameterSchema({
        key: { type: 'string', description: 'Key to press (e.g., Enter, Tab, Escape, a, 1)', required: true },
        modifiers: { type: 'object', description: 'Modifier keys: { ctrl: boolean, shift: boolean, alt: boolean, meta: boolean }' },
        tabId: { type: 'number', description: 'Specific tab ID (optional)' },
      }),
      async (args) => bridge.sendCommand('press_key', {
        key: args.key as string,
        modifiers: args.modifiers as Record<string, boolean> | undefined,
        tabId: args.tabId as number | undefined,
      }),
      { permissionAction: 'interact' },
    );

    this.registerTool(
      'scroll',
      'Scroll the page in a direction, to an absolute position, or to a specific element.',
      createParameterSchema({
        direction: { type: 'string', description: 'Scroll direction: up, down, left, right, top, bottom' },
        amount: { type: 'number', description: 'Pixels to scroll (default: 500)' },
        selector: { type: 'string', description: 'CSS selector to scroll into view (overrides direction)' },
        tabId: { type: 'number', description: 'Specific tab ID (optional)' },
      }),
      async (args) => bridge.sendCommand('scroll', {
        direction: args.direction as string | undefined,
        amount: args.amount as number | undefined,
        selector: args.selector as string | undefined,
        tabId: args.tabId as number | undefined,
      }),
      { permissionAction: 'interact' },
    );

    this.registerTool(
      'drag',
      'Drag an element from source to target using HTML5 drag and drop events.',
      createParameterSchema({
        sourceSelector: { type: 'string', description: 'CSS selector of the element to drag', required: true },
        targetSelector: { type: 'string', description: 'CSS selector of the drop target', required: true },
        tabId: { type: 'number', description: 'Specific tab ID (optional)' },
      }),
      async (args) => bridge.sendCommand('drag', {
        sourceSelector: args.sourceSelector as string,
        targetSelector: args.targetSelector as string,
        tabId: args.tabId as number | undefined,
      }),
      { permissionAction: 'interact' },
    );

    // ── Waiting & Debugging ──

    this.registerTool(
      'wait_for',
      'Wait for an element to appear or text to be present on the page. Polls every 200ms until found or timeout.',
      createParameterSchema({
        selector: { type: 'string', description: 'CSS selector to wait for' },
        text: { type: 'string', description: 'Text content to wait for on the page' },
        timeout: { type: 'number', description: 'Max wait time in ms (default: 10000)' },
        tabId: { type: 'number', description: 'Specific tab ID (optional)' },
      }),
      async (args) => bridge.sendCommand('wait_for', {
        selector: args.selector as string | undefined,
        text: args.text as string | undefined,
        timeout: args.timeout as number | undefined,
        tabId: args.tabId as number | undefined,
      }),
      { requiresPermission: false },
    );

    this.registerTool(
      'highlight',
      'Visually highlight an element on the page for debugging. Shows a colored overlay that fades after a duration.',
      createParameterSchema({
        selector: { type: 'string', description: 'CSS selector of the element to highlight', required: true },
        color: { type: 'string', description: 'Highlight color (default: rgba(66, 133, 244, 0.3))' },
        duration: { type: 'number', description: 'Duration in ms (default: 2000)' },
        tabId: { type: 'number', description: 'Specific tab ID (optional)' },
      }),
      async (args) => bridge.sendCommand('highlight', {
        selector: args.selector as string,
        color: args.color as string | undefined,
        duration: args.duration as number | undefined,
        tabId: args.tabId as number | undefined,
      }),
      { requiresPermission: false },
    );

    // ── JavaScript & State ──

    this.registerTool(
      'evaluate',
      'Execute a JavaScript expression in the page context and return the result.',
      createParameterSchema({
        expression: { type: 'string', description: 'JavaScript expression to evaluate', required: true },
        tabId: { type: 'number', description: 'Specific tab ID (optional)' },
      }),
      async (args) => bridge.sendCommand('evaluate', {
        expression: args.expression as string,
        tabId: args.tabId as number | undefined,
      }),
      { permissionAction: 'evaluate' },
    );

    this.registerTool(
      'get_cookies',
      'Get cookies for a specific domain from the user\'s browser.',
      createParameterSchema({
        domain: { type: 'string', description: 'Domain to get cookies for (e.g., "github.com")', required: true },
      }),
      async (args) => bridge.sendCommand('get_cookies', {
        domain: args.domain as string,
      }),
      { permissionAction: 'cookies' },
    );

    this.registerTool(
      'set_cookies',
      'Set a cookie in the user\'s browser.',
      createParameterSchema({
        name: { type: 'string', description: 'Cookie name', required: true },
        value: { type: 'string', description: 'Cookie value', required: true },
        url: { type: 'string', description: 'URL context for the cookie', required: true },
        domain: { type: 'string', description: 'Cookie domain (optional)' },
        path: { type: 'string', description: 'Cookie path (optional, default: /)' },
        secure: { type: 'boolean', description: 'Secure flag (optional)' },
        httpOnly: { type: 'boolean', description: 'HttpOnly flag (optional)' },
      }),
      async (args) => bridge.sendCommand('set_cookies', {
        name: args.name as string,
        value: args.value as string,
        url: args.url as string,
        domain: args.domain as string | undefined,
        path: args.path as string | undefined,
        secure: args.secure as boolean | undefined,
        httpOnly: args.httpOnly as boolean | undefined,
      }),
      { permissionAction: 'cookies' },
    );

    this.registerTool(
      'get_storage',
      'Read localStorage or sessionStorage entries from the current page.',
      createParameterSchema({
        storageType: { type: 'string', description: 'Storage type: "local" or "session" (default: local)' },
        key: { type: 'string', description: 'Specific key to read (optional — returns all entries if omitted)' },
        tabId: { type: 'number', description: 'Specific tab ID (optional)' },
      }),
      async (args) => bridge.sendCommand('get_storage', {
        storageType: args.storageType as string | undefined,
        key: args.key as string | undefined,
        tabId: args.tabId as number | undefined,
      }),
      { permissionAction: 'cookies' },
    );

    this.registerTool(
      'set_storage',
      'Write to localStorage or sessionStorage on the current page. Set value to null to remove.',
      createParameterSchema({
        key: { type: 'string', description: 'Storage key', required: true },
        value: { type: 'string', description: 'Value to set (null to remove)', required: true },
        storageType: { type: 'string', description: 'Storage type: "local" or "session" (default: local)' },
        tabId: { type: 'number', description: 'Specific tab ID (optional)' },
      }),
      async (args) => bridge.sendCommand('set_storage', {
        storageType: args.storageType as string | undefined,
        key: args.key as string,
        value: args.value as string,
        tabId: args.tabId as number | undefined,
      }),
      { permissionAction: 'cookies' },
    );

    // ── Monitoring ──

    this.registerTool(
      'get_console',
      'Get captured console log entries from the page. Installs an interceptor on first call. Captures log, warn, error, and info levels.',
      createParameterSchema({
        level: { type: 'string', description: 'Filter by level: log, warn, error, info (optional — returns all if omitted)' },
        clear: { type: 'boolean', description: 'Clear the buffer after reading (default: false)' },
        tabId: { type: 'number', description: 'Specific tab ID (optional)' },
      }),
      async (args) => bridge.sendCommand('get_console', {
        level: args.level as string | undefined,
        clear: args.clear as boolean | undefined,
        tabId: args.tabId as number | undefined,
      }),
      { permissionAction: 'extract' },
    );

    this.registerTool(
      'get_network',
      'Get captured network requests from the page via the Performance Resource Timing API. Installs a PerformanceObserver on first call.',
      createParameterSchema({
        filter: { type: 'string', description: 'Filter by URL substring or resource type (optional)' },
        clear: { type: 'boolean', description: 'Clear the buffer after reading (default: false)' },
        tabId: { type: 'number', description: 'Specific tab ID (optional)' },
      }),
      async (args) => bridge.sendCommand('get_network', {
        filter: args.filter as string | undefined,
        clear: args.clear as boolean | undefined,
        tabId: args.tabId as number | undefined,
      }),
      { permissionAction: 'extract' },
    );

    // ── Dialog Handling ──

    this.registerTool(
      'handle_dialog',
      'Set up a handler for the next browser dialog (alert, confirm, or prompt). Must be called before the dialog appears.',
      createParameterSchema({
        action: { type: 'string', description: 'Action: "accept" or "dismiss"', required: true },
        text: { type: 'string', description: 'Text to enter in a prompt dialog (optional)' },
        tabId: { type: 'number', description: 'Specific tab ID (optional)' },
      }),
      async (args) => bridge.sendCommand('handle_dialog', {
        action: args.action as string,
        text: args.text as string | undefined,
        tabId: args.tabId as number | undefined,
      }),
      { permissionAction: 'interact' },
    );
  }
}

export const browserExtTool = new BrowserExtTool();
