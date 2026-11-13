/**
 * Capability gates (docs/MODULES.md → Capability gates): what this install
 * has a model for. A module is the operator's switch; a capability is what is
 * configured. A feature is on only when both are: its module is on AND every
 * capability it needs is configured. Not configured means off, not degraded:
 * its tools are in no agent's tool set, its prompt text is left out, its
 * background jobs do not run and its pages leave the UI.
 *
 * Shared by the backend and the web build, so it holds no runtime imports.
 */
export const CAPABILITIES = ['embedding', 'see', 'ocr', 'draw', 'hear', 'speak'] as const;
export type Capability = (typeof CAPABILITIES)[number];

export interface CapabilityInfo {
  title: string;
  /** What is missing, said the way the user would act on it. */
  needs: string;
  /** Where it is set up (a web route). */
  setupHref: string;
}

export const CAPABILITY_INFO: Readonly<Record<Capability, CapabilityInfo>> = {
  embedding: {
    title: 'Search & memory',
    needs: 'an embedding model',
    setupHref: '/topics',
  },
  see: {
    title: 'Reading images',
    needs: 'a model that can read images (a vision-capable main model, or one bound to the Vision lane)',
    setupHref: '/topics',
  },
  ocr: {
    title: 'Reading scanned documents',
    needs: 'an OCR or vision model',
    setupHref: '/topics',
  },
  draw: {
    title: 'Image generation',
    needs: 'an image generation model',
    setupHref: '/topics',
  },
  hear: {
    title: 'Speech to text',
    needs: 'a transcription model',
    setupHref: '/topics',
  },
  speak: {
    title: 'Text to speech',
    needs: 'a speech model',
    setupHref: '/topics',
  },
};

/**
 * Web pages that need a capability: hidden from navigation while it is off,
 * and reached directly they say what is missing (web/components/module-gate).
 */
export const CAPABILITY_PAGES: Readonly<Record<string, Capability>> = {
  '/knowledge': 'embedding',
  '/recall': 'embedding',
  '/memory': 'embedding',
};

/** The capability the page at `pathname` needs, if any. */
export function capabilityOfPage(pathname: string): Capability | undefined {
  for (const [page, cap] of Object.entries(CAPABILITY_PAGES)) {
    if (pathname === page || pathname.startsWith(`${page}/`)) return cap;
  }
  return undefined;
}

export function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && (CAPABILITIES as readonly string[]).includes(value);
}

/** One capability as `/api/modules` reports it. */
export interface CapabilityView {
  id: Capability;
  title: string;
  on: boolean;
  /** Why it is off, for a person. Absent when on. */
  reason?: string;
  setupHref: string;
}

/** The sentence an agent, an API caller or a page gets when a capability is off. */
export function capabilityOffText(cap: Capability): string {
  const info = CAPABILITY_INFO[cap];
  return `${info.title} is not configured on this install: it needs ${info.needs}. An admin sets it up on the Topics page.`;
}
