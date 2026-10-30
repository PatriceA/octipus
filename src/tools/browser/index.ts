import type { BrowserContext, Page } from 'playwright';
import {redactCredentialData} from '@/security/credential-redaction';
import {getVault} from '@/security/vault';
import {fillLoginFields} from './login-fill';
import type {AgentContext, ToolManifest } from '@/core/types';
import { decide, decisionModelBound, type DecisionSite, recordShadow } from '@/models/decision';
import { coreLogger, toolLogger } from '@/utils/logger';
import { BaseTool, createParameterSchema, type ToolAvailability, type ToolExecutionOptions } from '../base-tool';
import { sharedChromium } from './shared-chromium';

const DEFAULT_TIMEOUT = 30000;

const _MAX_SCREENSHOT_SIZE = 5 * 1024 * 1024; // 5MB

/**
 * Where Playwright expects its Chromium, asked once of a short-lived child
 * process. Importing `playwright` here costs ~0.3 s and ~80 MB that stay
 * resident for the life of the server, and the boot-time availability probe
 * would pay that on every install, whether or not an agent ever opens a
 * browser. The browser itself still loads Playwright in-process, on first use.
 * The path never moves while the server runs; only whether it exists does.
 */
let chromiumPath: Promise<string> | null = null;
function chromiumExecutablePath(): Promise<string> {
  chromiumPath ??= (async () => {
    const { createRequire } = await import('node:module');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const entry = createRequire(import.meta.url).resolve('playwright');
    const program = `process.stdout.write(require(${JSON.stringify(entry)}).chromium.executablePath())`;
    const { stdout } = await promisify(execFile)(process.execPath, ['-e', program], {
      timeout: 15_000,
      windowsHide: true,
    });
    return stdout.trim();
  })();
  // A failed lookup is not remembered; the next probe asks again.
  chromiumPath.catch(() => { chromiumPath = null; });
  return chromiumPath;
}

export class BrowserTool extends BaseTool {
  readonly id = 'browser';
  readonly name = 'Browser';
  readonly version = '1.0.0';
  readonly description = 'Web browser automation using Playwright';

  override async checkAvailability(): Promise<ToolAvailability> {
    try {
      const { existsSync } = await import('node:fs');
      const hasPlaywright = existsSync(await chromiumExecutablePath());
      if (!hasPlaywright) {
        return { available: false, reason: 'Playwright browsers not installed (run: npx playwright install chromium)' };
      }
      return { available: true };
    } catch {
      return { available: false, reason: 'Playwright not available' };
    }
  }

  private contexts: Map<string, BrowserContext> = new Map();
  private pages: Map<string, Page> = new Map();
  private pageOwners=new Map<string,string>();
  private owner(context:AgentContext):string{return `${context.userId}:${context.workspaceId??''}:${context.space?'shared':'private'}`;}

  private scriptedContexts=new WeakSet<BrowserContext>();
  private protectedContexts=new WeakMap<BrowserContext,string[]>();
  private commandTail:Promise<unknown>=Promise.resolve();
  protected override registerTool(name:string,description:string,parameters:Record<string,unknown>,execute:(args:Record<string,unknown>,context:AgentContext)=>Promise<unknown>,options?:ToolExecutionOptions):void{
    super.registerTool(name,description,parameters,(args,context)=>{
      const run=this.commandTail.catch(()=>{}).then(async()=>{
        const browserContext=this.pages.has(args.pageId as string)?this.getPage(args.pageId as string,context).context():args.contextId?this.contexts.get(`${this.owner(context)}:${args.contextId}`):undefined;
        const values=browserContext?this.protectedContexts.get(browserContext):undefined;
        if(name==='evaluate'&&browserContext)this.scriptedContexts.add(browserContext);
        if(values&&['evaluate','screenshot','pdf','get_html'].includes(name))throw new Error('This browser contains a saved Login. Script execution and raw captures are disabled; use normal page controls.');
        try{
          const result=await execute(args,context);
          const mask=browserContext?this.protectedContexts.get(browserContext):undefined;
          return mask?redactCredentialData(result,mask):result;
        }catch(error){
          if(browserContext&&this.protectedContexts.has(browserContext))throw new Error('Browser command failed in a protected Login session; credential-bearing details withheld');
          throw error;
        }
      });
      this.commandTail=run;return run;
    },options);
  }

  constructor() {
    super();
    // The shared browser closes when idle (or crashes): its pages and
    // contexts go with it, so their handles are dropped here.
    sharedChromium.onClosed(() => {
      this.pages.clear();
      this.pageOwners.clear();
      this.protectedContexts=new WeakMap();
      this.scriptedContexts=new WeakSet();
      this.contexts.clear();
    });
  }

  getManifest(): ToolManifest {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      permissions: [
        { action: 'navigate', description: 'Open and navigate to URLs in a headless Playwright browser', defaultLevel: 'ASK' },
        { action: 'interact', description: 'Click buttons, fill forms, and type text on web pages via Playwright', defaultLevel: 'ASK' },
        { action: 'screenshot', description: 'Capture PNG screenshots of web pages in the headless browser', defaultLevel: 'ALLOW' },
        { action: 'execute', description: 'Run arbitrary JavaScript code in the context of the loaded web page', defaultLevel: 'ASK', dangerous: true },
      ],
      tools: [{name:'fill_login',description:'Fill a domain-bound vault Login without exposing its credentials. Does not submit.',parameters:{credential:{type:'string',description:'Login name',required:true},pageId:{type:'string',description:'Page ID',required:true},usernameSelector:{type:'string',description:'Username input selector',required:true},passwordSelector:{type:'string',description:'Password input selector',required:true}},returns:'Filled confirmation'},],
    };
  }

  protected async registerTools(): Promise<void> {
    this.registerTool('fill_login','Fill a saved Login on its exact domain. Credentials stay out of tool arguments. Does not submit.',createParameterSchema({
      credential:{type:'string',description:'Vault Login entry name',required:true},pageId:{type:'string',description:'Page ID',required:true},
      usernameSelector:{type:'string',description:'Unique username input CSS selector',required:true},passwordSelector:{type:'string',description:'Unique password input CSS selector',required:true},
    }),async(args,context)=>{
      if(context.space||!this.pageOwners.has(args.pageId as string))throw new Error('A private browser page owned by this user is required');
      const page=this.getPage(args.pageId as string,context);
      if(this.scriptedContexts.has(page.context()))throw new Error('Use a fresh browser context for saved Logins; arbitrary scripts were previously run here');
      const origin=new URL(page.url()).origin;
      const login=await getVault().getLoginAuthorized({...context,toolId:this.id,agentId:context.id},args.credential as string,origin);
      if(!login)throw new Error('Login unavailable, expired, denied, or bound to a different domain');
      this.protectedContexts.set(page.context(),[...(this.protectedContexts.get(page.context())??[]),login.username,login.password,Buffer.from(`${login.username}:${login.password}`).toString('base64')]);
      try{
        const filled=await page.evaluate(fillLoginFields,{origin,username:login.username,password:login.password,usernameSelector:args.usernameSelector as string,passwordSelector:args.passwordSelector as string});
        if(!filled)throw new Error();
        return {filled:true,origin,submitted:false};
      }catch{throw new Error('Login was not filled. Check the domain and visible same-origin username/password fields.');}
    },{permissionAction:'interact'});

    this.registerTool(
      'open',
      'Open a new browser page',
      createParameterSchema({
        url: { type: 'string', description: 'URL to navigate to', required: true },
        contextId: { type: 'string', description: 'Browser context ID' },
        headless: { type: 'boolean', description: 'Run headless', default: true },
      }),
      async (args, context) => {
        const { validateExternalUrl, assertPublicAddress } = await import('@/utils/sanitize');
        const validation = await validateExternalUrl(args.url as string);
        if (!validation.valid) {
          return { error: `URL blocked: ${validation.reason}` };
        }

        const page = await this.getOrCreatePage(args.contextId?`${this.owner(context)}:${args.contextId}`:undefined);
        const response = await page.goto(args.url as string, { timeout: DEFAULT_TIMEOUT });

        // Post-connect SSRF check: Playwright can't be IP-pinned, so verify the
        // address actually connected to wasn't a private IP a rebinding resolver
        // swapped in between validation and navigation.
        const addrCheck = assertPublicAddress((await response?.serverAddr())?.ipAddress);
        if (!addrCheck.ok) {
          // Never handed out, so nothing would ever close it: close it now
          // (its own context goes with it, see getOrCreatePage).
          await page.close().catch((err: unknown) => toolLogger.warn({ err }, 'Closing a blocked page failed'));
          return { error: `URL blocked: ${addrCheck.reason}` };
        }

        const pageId = this.generatePageId();
        this.pages.set(pageId, page);
        this.pageOwners.set(pageId,this.owner(context));

        return {
          pageId,
          url: page.url(),
          title: await page.title(),
          ...(this.protectedContexts.has(page.context())?{}:await pageStateHints(page)),
        };
      },
      { permissionAction: 'navigate' }
    );

    this.registerTool(
      'navigate',
      'Navigate to a URL on an existing page',
      createParameterSchema({
        pageId: { type: 'string', description: 'Page ID', required: true },
        url: { type: 'string', description: 'URL to navigate to', required: true },
      }),
      async (args, context) => {
        const { validateExternalUrl, assertPublicAddress } = await import('@/utils/sanitize');
        const validation = await validateExternalUrl(args.url as string);
        if (!validation.valid) {
          return { error: `URL blocked: ${validation.reason}` };
        }

        const page = this.getPage(args.pageId as string,context);
        const response = await page.goto(args.url as string, { timeout: DEFAULT_TIMEOUT });

        // Post-connect SSRF check (see comment in `open`).
        const addrCheck = assertPublicAddress((await response?.serverAddr())?.ipAddress);
        if (!addrCheck.ok) {
          await page.goto('about:blank').catch(() => {});
          return { error: `URL blocked: ${addrCheck.reason}` };
        }

        return {
          url: page.url(),
          title: await page.title(),
          ...(this.protectedContexts.has(page.context())?{}:await pageStateHints(page)),
        };
      },
      { permissionAction: 'navigate' }
    );

    this.registerTool(
      'click',
      'Click an element on the page',
      createParameterSchema({
        pageId: { type: 'string', description: 'Page ID', required: true },
        selector: { type: 'string', description: 'CSS selector or text', required: true },
      }),
      async (args, context) => {
        const page = this.getPage(args.pageId as string,context);
        await page.click(args.selector as string, { timeout: DEFAULT_TIMEOUT });

        return { clicked: args.selector, url: page.url() };
      },
      { permissionAction: 'interact' }
    );

    this.registerTool(
      'type',
      'Type text into an input field',
      createParameterSchema({
        pageId: { type: 'string', description: 'Page ID', required: true },
        selector: { type: 'string', description: 'Input selector', required: true },
        text: { type: 'string', description: 'Text to type', required: true },
        clear: { type: 'boolean', description: 'Clear field first', default: false },
      }),
      async (args, context) => {
        const page = this.getPage(args.pageId as string,context);

        if (args.clear) {
          await page.fill(args.selector as string, '');
        }

        await page.type(args.selector as string, args.text as string);

        return { typed: args.text, selector: args.selector };
      },
      { permissionAction: 'interact' }
    );

    this.registerTool(
      'screenshot',
      'Take a screenshot of the page',
      createParameterSchema({
        pageId: { type: 'string', description: 'Page ID', required: true },
        fullPage: { type: 'boolean', description: 'Capture full page', default: false },
        selector: { type: 'string', description: 'Element selector to screenshot' },
      }),
      async (args, context) => {
        const page = this.getPage(args.pageId as string,context);
        let screenshot: Buffer;

        if (args.selector) {
          const element = await page.locator(args.selector as string).first();
          screenshot = await element.screenshot();
        } else {
          screenshot = await page.screenshot({ fullPage: args.fullPage as boolean });
        }

        return {
          base64: screenshot.toString('base64'),
          size: screenshot.length,
          url: page.url(),
        };
      },
      { permissionAction: 'screenshot' }
    );

    this.registerTool(
      'get_text',
      'Get text content from the page',
      createParameterSchema({
        pageId: { type: 'string', description: 'Page ID', required: true },
        selector: { type: 'string', description: 'Element selector' },
      }),
      async (args, context) => {
        const page = this.getPage(args.pageId as string,context);

        if (args.selector) {
          const element = await page.locator(args.selector as string).first();
          return { text: await element.textContent() };
        }

        return { text: await page.textContent('body') };
      },
      { permissionAction: 'navigate', requiresPermission: false }
    );

    this.registerTool(
      'get_html',
      'Get HTML content from the page',
      createParameterSchema({
        pageId: { type: 'string', description: 'Page ID', required: true },
        selector: { type: 'string', description: 'Element selector' },
      }),
      async (args, context) => {
        const page = this.getPage(args.pageId as string,context);

        if (args.selector) {
          const element = await page.locator(args.selector as string).first();
          return { html: await element.innerHTML() };
        }

        return { html: await page.content() };
      },
      { permissionAction: 'navigate', requiresPermission: false }
    );

    this.registerTool(
      'evaluate',
      'Execute JavaScript in the page context',
      createParameterSchema({
        pageId: { type: 'string', description: 'Page ID', required: true },
        script: { type: 'string', description: 'JavaScript code', required: true },
      }),
      async (args, context) => {
        const page = this.getPage(args.pageId as string,context);
        const result = await page.evaluate(args.script as string);

        return { result };
      },
      { permissionAction: 'execute' }
    );

    this.registerTool(
      'wait_for',
      'Wait for an element or condition',
      createParameterSchema({
        pageId: { type: 'string', description: 'Page ID', required: true },
        selector: { type: 'string', description: 'Element selector' },
        state: { type: 'string', description: 'Element state', default: 'visible', enum: ['visible', 'hidden', 'attached', 'detached'] },
        timeout: { type: 'number', description: 'Timeout in ms', default: DEFAULT_TIMEOUT },
      }),
      async (args, context) => {
        const page = this.getPage(args.pageId as string,context);

        if (args.selector) {
          await page.waitForSelector(args.selector as string, {
            state: args.state as 'visible' | 'hidden' | 'attached' | 'detached',
            timeout: args.timeout as number,
          });
        }

        return { success: true };
      },
      { permissionAction: 'navigate', requiresPermission: false }
    );

    this.registerTool(
      'close',
      'Close a browser page',
      createParameterSchema({
        pageId: { type: 'string', description: 'Page ID', required: true },
      }),
      async (args, context) => {
        const page = this.pages.has(args.pageId as string)?this.getPage(args.pageId as string,context):undefined;
        if (page) {
          await page.close();
          this.pages.delete(args.pageId as string);
          this.pageOwners.delete(args.pageId as string);
        }

        return { closed: args.pageId };
      },
      { permissionAction: 'navigate' }
    );

    this.registerTool(
      'select',
      'Select an option from a dropdown',
      createParameterSchema({
        pageId: { type: 'string', description: 'Page ID', required: true },
        selector: { type: 'string', description: 'Select element selector', required: true },
        value: { type: 'string', description: 'Option value or label', required: true },
      }),
      async (args, context) => {
        const page = this.getPage(args.pageId as string,context);
        await page.selectOption(args.selector as string, args.value as string);

        return { selected: args.value, selector: args.selector };
      },
      { permissionAction: 'interact' }
    );

    this.registerTool(
      'scroll',
      'Scroll the page',
      createParameterSchema({
        pageId: { type: 'string', description: 'Page ID', required: true },
        direction: { type: 'string', description: 'Scroll direction', default: 'down', enum: ['up', 'down', 'left', 'right'] },
        amount: { type: 'number', description: 'Scroll amount in pixels', default: 500 },
      }),
      async (args, context) => {
        const page = this.getPage(args.pageId as string,context);
        const amount = args.amount as number || 500;

        const scrollMap = {
          down: [0, amount],
          up: [0, -amount],
          right: [amount, 0],
          left: [-amount, 0],
        };

        const [x, y] = scrollMap[args.direction as keyof typeof scrollMap] || [0, amount];
        await page.evaluate(([dx, dy]) => window.scrollBy(dx, dy), [x, y]);

        return { scrolled: args.direction, amount };
      },
      { permissionAction: 'interact' }
    );

    this.registerTool(
      'hover',
      'Hover over an element on the page',
      createParameterSchema({
        pageId: { type: 'string', description: 'Page ID', required: true },
        selector: { type: 'string', description: 'CSS selector to hover', required: true },
      }),
      async (args, context) => {
        const page = this.getPage(args.pageId as string,context);
        await page.hover(args.selector as string, { timeout: DEFAULT_TIMEOUT });
        return { hovered: args.selector };
      },
      { permissionAction: 'interact' }
    );

    this.registerTool(
      'press_key',
      'Press a keyboard key on the page',
      createParameterSchema({
        pageId: { type: 'string', description: 'Page ID', required: true },
        key: { type: 'string', description: 'Key to press (Enter, Tab, Escape, etc.)', required: true },
      }),
      async (args, context) => {
        const page = this.getPage(args.pageId as string,context);
        await page.keyboard.press(args.key as string);
        return { pressed: args.key };
      },
      { permissionAction: 'interact' }
    );

    this.registerTool(
      'drag',
      'Drag an element to a target position',
      createParameterSchema({
        pageId: { type: 'string', description: 'Page ID', required: true },
        sourceSelector: { type: 'string', description: 'Source element selector', required: true },
        targetSelector: { type: 'string', description: 'Target element selector', required: true },
      }),
      async (args, context) => {
        const page = this.getPage(args.pageId as string,context);
        await page.dragAndDrop(args.sourceSelector as string, args.targetSelector as string, { timeout: DEFAULT_TIMEOUT });
        return { dragged: args.sourceSelector, to: args.targetSelector };
      },
      { permissionAction: 'interact' }
    );

    this.registerTool(
      'pdf',
      'Generate a PDF of the current page',
      createParameterSchema({
        pageId: { type: 'string', description: 'Page ID', required: true },
        format: { type: 'string', description: 'Paper format (A4, Letter, etc.)', default: 'A4' },
      }),
      async (args, context) => {
        const page = this.getPage(args.pageId as string,context);
        const buffer = await page.pdf({
          format: (args.format as string) || 'A4',
          printBackground: true,
        });
        return {
          base64: buffer.toString('base64'),
          size: buffer.length,
          url: page.url(),
        };
      },
      { permissionAction: 'screenshot' }
    );
  }

  private async getOrCreatePage(contextId?: string): Promise<Page> {
    const browser = await sharedChromium.get();

    if (contextId && this.contexts.has(contextId)) {
      return this.contexts.get(contextId)!.newPage();
    }

    const context = await browser.newContext();
    if (contextId) {
      this.contexts.set(contextId, context);
      return context.newPage();
    }

    // A context of its own, tracked by nothing: it lives as long as its page.
    const page = await context.newPage();
    page.once('close', () => {
      context.close().catch((err: unknown) => toolLogger.warn({ err }, 'Closing a page context failed'));
    });
    return page;
  }

  private getPage(pageId: string, context:AgentContext): Page {
    const owner=this.pageOwners.get(pageId);
    if(owner&&owner!==this.owner(context))throw new Error('Browser page access denied');
    const page = this.pages.get(pageId);
    if (!page) {
      throw new Error(`Page not found: ${pageId} (pages close with the browser after ${sharedChromium.idleMinutes} min idle)`);
    }
    sharedChromium.touch();
    return page;
  }

  private generatePageId(): string {
    return `page_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  }

  override async shutdown(): Promise<void> {
    for (const page of this.pages.values()) {
      await page.close().catch((err: unknown) => coreLogger.error({ err }, 'background task failed in index'));
    }
    this.pages.clear();
      this.pageOwners.clear();
      this.protectedContexts=new WeakMap();
      this.scriptedContexts=new WeakSet();

    for (const context of this.contexts.values()) {
      await context.close().catch((err: unknown) => coreLogger.error({ err }, 'background task failed in index'));
    }
    this.contexts.clear();

    await sharedChromium.close();
  }
}

export const browserTool = new BrowserTool();

/**
 * Decision-model page-state hints (docs/plans/decision-models.md, site 10):
 * after a navigation, ask whether the page is blocked by a cookie banner, a
 * login wall or a captcha, so the agent can deal with it instead of reading
 * a blocked page. Live mode includes confident hints in the tool response.
 * Agent-driven pages can carry the owner's logged-in content → `personal`.
 */
const BROWSER_SITE: DecisionSite = { id: 'browser.page-state', sensitivity: 'personal', minConfidence: 0 };
const BROWSER_HINTS_LIVE = true;
const HINT_P = 0.8;
const SNAPSHOT_TIMEOUT_MS = 1000;
const PAGE_QUESTIONS = {
  cookieBanner: { type: 'noul' as const, instructions: 'A cookie or consent banner or dialog is shown that must be accepted or dismissed.' },
  loginWall: { type: 'noul' as const, instructions: 'The content is hidden behind a sign-in or registration requirement.' },
  captcha: { type: 'noul' as const, instructions: 'The page shows a captcha or bot check instead of its content.' },
};

async function pageStateHints(page: Page): Promise<{ pageState?: string[] }> {
  if (!(await decisionModelBound())) return {};
  // Snapshot is capped at SNAPSHOT_TIMEOUT_MS — Playwright's default action timeout
  // is 30s, and a body that is not ready yet must not stall the tool reply.
  const state = { url: page.url(), title: await page.title().catch(() => ''), text: (await page.innerText('body', { timeout: SNAPSHOT_TIMEOUT_MS }).catch(() => '')).slice(0, 6000) };
  const ask = async () => {
    const answers = await decide(BROWSER_SITE, state, PAGE_QUESTIONS);
    return answers ? Object.entries(answers).filter(([, a]) => a.type === 'noul' && a.p >= HINT_P).map(([k]) => k) : null;
  };
  if (!BROWSER_HINTS_LIVE) {
    void ask().then((hints) => { if (hints) recordShadow({ site: BROWSER_SITE.id, wouldAdd: hints }); });
    return {};
  }
  const hints = await ask();
  return hints?.length ? { pageState: hints } : {};
}
