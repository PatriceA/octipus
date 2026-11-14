/**
 * Capability gates (docs/MODULES.md → Capability gates).
 *
 * The only thing Octipus needs is one chat model. Everything else — search &
 * memory (embedding), reading images, OCR, image generation, speech to text,
 * text to speech — is optional, and NOT CONFIGURED MEANS OFF:
 *
 *   - tools that need it are in no agent's tool set (`ToolHandler.requires`),
 *     and a stale call is refused with `capabilityOffMessage`;
 *   - prompt text marked `<!-- cap:<id> -->` is left out (core/modules/prompt);
 *   - background work that needs it does not start (each such path checks
 *     the capability before doing anything — see docs/MODULES.md);
 *   - routes that need it answer 409 `capability_not_configured`;
 *   - the web hides its pages and controls (`/api/modules` → `capabilities`).
 *
 * The answers live in an in-memory SNAPSHOT so every check is synchronous
 * (tool filtering, prompt rendering and `isJobOn` are all synchronous). It is
 * refreshed at boot before anything is served, whenever a model row or a topic
 * binding changes (`ModelRegistry` calls `notifyCapabilitiesChanged`), when a
 * relevant setting changes, on a pub/sub message from another process, and
 * every minute as a backstop. Until the first refresh every capability reads
 * as OFF: unknown is not configured, so nothing appears and then vanishes.
 */
import { CAPABILITIES, CAPABILITY_INFO, type Capability, type CapabilityView, capabilityOffText } from '@/shared/capabilities';
import { coreLogger } from '@/utils/logger';

export type { Capability } from '@/shared/capabilities';

export interface CapabilityState {
  on: boolean;
  /** Why it is off. */
  reason?: string;
}

export type CapabilitySnapshot = Readonly<Record<Capability, CapabilityState>>;

const OFF_UNKNOWN: CapabilityState = { on: false, reason: 'not checked yet' };

function unknownSnapshot(): CapabilitySnapshot {
  return Object.fromEntries(CAPABILITIES.map((c) => [c, OFF_UNKNOWN])) as CapabilitySnapshot;
}

/**
 * The test lane starts with every capability on, as it starts with every
 * module on (src/test-setup.ts): the suites of a gated tool run against it
 * configured, and the tests of "off" set the snapshot themselves.
 */
// Honoured in the test lane only: a stray variable must never freeze a real install's gates on.
const ALL_ON_FOR_TESTS = process.env.OCTIPUS_CAPABILITIES_ALL_ON === '1' && (process.env.NODE_ENV === 'test' || !!process.env.VITEST);

function initialSnapshot(): CapabilitySnapshot {
  if (!ALL_ON_FOR_TESTS) return unknownSnapshot();
  return Object.fromEntries(CAPABILITIES.map((c) => [c, { on: true }])) as CapabilitySnapshot;
}

let snapshot: CapabilitySnapshot = initialSnapshot();
let computedAt = ALL_ON_FOR_TESTS ? Date.now() : 0;
/**
 * Tests: a snapshot set by the test is not replaced by a refresh that a model
 * write elsewhere in the file happens to trigger. A test that resets the
 * snapshot (and installs its own resolvers) refreshes for real again.
 */
let pinnedForTest = ALL_ON_FOR_TESTS;
const listeners = new Set<(next: CapabilitySnapshot, previous: CapabilitySnapshot) => void>();

/** Whether `cap` is configured. Synchronous; reads the snapshot. */
export function isCapabilityOn(cap: Capability): boolean {
  return snapshot[cap].on;
}

/** Every capability in `caps` is configured (an empty list is always met). */
export function capabilitiesMet(caps: readonly Capability[] | undefined): boolean {
  return !caps || caps.every(isCapabilityOn);
}

/** The first capability of `caps` that is off, if any. */
export function firstOffCapability(caps: readonly Capability[] | undefined): Capability | undefined {
  return caps?.find((cap) => !isCapabilityOn(cap));
}

export function capabilitySnapshot(): CapabilitySnapshot {
  return snapshot;
}

/** What a refused call of a gated tool, route or job says. */
export function capabilityOffMessage(cap: Capability): string {
  return `${capabilityOffText(cap)} This is not available; do not retry.`;
}

/** Thrown by code that must not run without a capability (a missed caller fails loud, once). */
export class CapabilityNotConfiguredError extends Error {
  readonly code = 'capability_not_configured';
  constructor(readonly capability: Capability) {
    super(capabilityOffText(capability));
    this.name = 'CapabilityNotConfiguredError';
  }
}

export function assertCapability(cap: Capability): void {
  if (!isCapabilityOn(cap)) throw new CapabilityNotConfiguredError(cap);
}

/**
 * The snapshot, computed on first use when nothing computed it yet. The
 * server computes it at boot; a standalone process (a script, the eval CLI)
 * that never called `initCapabilityGates` gets the real answer here instead
 * of "not checked yet = off".
 */
export async function ensureCapabilitiesKnown(): Promise<CapabilitySnapshot> {
  // A snapshot computed while a resolver could not answer (a script that
  // checked before its database was up) is computed again on the next call.
  if (computedAt === 0 || lastRefreshHadErrors) await refreshCapabilities();
  return snapshot;
}

/** `isCapabilityOn` for async code that may run outside the server. */
export async function capabilityConfigured(cap: Capability): Promise<boolean> {
  await ensureCapabilitiesKnown();
  return isCapabilityOn(cap);
}

/** `assertCapability` for async code that may run outside the server. */
export async function requireCapability(cap: Capability): Promise<void> {
  await ensureCapabilitiesKnown();
  assertCapability(cap);
}

/** The capabilities as `/api/modules` reports them. */
export function capabilityViews(): CapabilityView[] {
  return CAPABILITIES.map((id) => ({
    id,
    title: CAPABILITY_INFO[id].title,
    on: snapshot[id].on,
    ...(snapshot[id].on ? {} : { reason: snapshot[id].reason ?? `needs ${CAPABILITY_INFO[id].needs}` }),
    setupHref: CAPABILITY_INFO[id].setupHref,
  }));
}

/** Called with the new and the previous snapshot whenever a capability flips. */
export function onCapabilitiesChanged(handler: (next: CapabilitySnapshot, previous: CapabilitySnapshot) => void): () => void {
  listeners.add(handler);
  return () => listeners.delete(handler);
}

// ── Computing the snapshot ──────────────────────────────────────────

/** How each capability is decided. Replaceable, so later lanes plug in without touching callers. */
export type CapabilityResolver = () => Promise<CapabilityState>;

type BoundRow = { topics?: string[] | null; topicRoles?: Record<string, unknown> | null; supportsVision?: boolean };

/** A row serves `topic` only when it carries it explicitly; the default model never stands in. */
function explicitlyBound(row: BoundRow | null | undefined, topic: string): boolean {
  return !!row && (row.topics?.includes(topic) === true || (!!row.topicRoles && topic in row.topicRoles));
}

async function registry() {
  const { getModelRegistry } = await import('@/models/model-registry');
  return getModelRegistry();
}

const embeddingResolver: CapabilityResolver = async () => {
  const row = await (await registry()).getModelForTopic('embedding');
  return explicitlyBound(row, 'embedding') ? { on: true } : { on: false, reason: `needs ${CAPABILITY_INFO.embedding.needs}` };
};

/** A media capability is configured when the media resolver finds someone to do it (src/models/media-resolver.ts). */
function mediaResolver(need: 'see' | 'ocr' | 'draw'): CapabilityResolver {
  return async () => {
    const { resolveMedia } = await import('@/models/media-resolver');
    const resolution = await resolveMedia(need);
    return resolution.mode === 'none' ? { on: false, reason: resolution.reason } : { on: true };
  };
}

const seeResolver = mediaResolver('see');
const ocrResolver = mediaResolver('ocr');
const drawResolver = mediaResolver('draw');

/**
 * Speech is configured when the model bound to its lane can run here now
 * (src/voice/resolve.ts: primary, then backup; local engines probed, cloud
 * engines need their key).
 */
function speechResolver(direction: 'stt' | 'tts'): CapabilityResolver {
  return async () => {
    const { speechStatus } = await import('@/voice/resolve');
    const status = await speechStatus(direction);
    return status.available ? { on: true } : { on: false, reason: status.reason ?? `needs ${CAPABILITY_INFO[direction === 'stt' ? 'hear' : 'speak'].needs}` };
  };
}

const hearResolver = speechResolver('stt');
const speakResolver = speechResolver('tts');

const resolvers: Record<Capability, CapabilityResolver> = {
  embedding: embeddingResolver,
  see: seeResolver,
  ocr: ocrResolver,
  draw: drawResolver,
  hear: hearResolver,
  speak: speakResolver,
};

/** Replace how one capability is decided (a later phase's lane resolver; tests). */
export function setCapabilityResolver(cap: Capability, resolver: CapabilityResolver): void {
  resolvers[cap] = resolver;
}

let inFlight: Promise<CapabilitySnapshot> | null = null;
/** The last refresh had a resolver that threw (its capability reads off "could not be checked"). */
let lastRefreshHadErrors = false;
let again = false;

/**
 * Recompute every capability. Concurrent calls share one computation; a call
 * that arrives during one schedules exactly one more, so a change made while
 * computing is never lost. A resolver that throws leaves that capability OFF
 * with the error as its reason (logged once per flip, not per check).
 */
export function refreshCapabilities(): Promise<CapabilitySnapshot> {
  if (pinnedForTest) return Promise.resolve(snapshot);
  if (inFlight) {
    again = true;
    return inFlight;
  }
  inFlight = (async () => {
    let result: CapabilitySnapshot;
    do {
      again = false;
      const entries = await Promise.all(CAPABILITIES.map(async (cap): Promise<[Capability, CapabilityState]> => {
        try {
          return [cap, await resolvers[cap]()];
        } catch (err) {
          return [cap, { on: false, reason: `could not be checked: ${(err as Error).message}` }];
        }
      }));
      result = Object.fromEntries(entries) as CapabilitySnapshot;
      lastRefreshHadErrors = entries.some(([, state]) => state.reason?.startsWith('could not be checked') === true);
      applySnapshot(result);
    } while (again);
    return result;
  })().finally(() => { inFlight = null; });
  return inFlight;
}

function applySnapshot(next: CapabilitySnapshot): void {
  const previous = snapshot;
  snapshot = next;
  computedAt = Date.now();
  const flipped = CAPABILITIES.filter((c) => previous[c].on !== next[c].on);
  if (flipped.length === 0) return;
  coreLogger.info({ capabilities: Object.fromEntries(flipped.map((c) => [c, next[c].on ? 'on' : `off (${next[c].reason})`])) }, 'Capabilities changed');
  for (const listener of listeners) {
    try {
      listener(next, previous);
    } catch (err) {
      coreLogger.error({ err }, 'Capability change listener failed');
    }
  }
}

/** When the snapshot was last computed (0 = never). */
export function capabilitiesComputedAt(): number {
  return computedAt;
}

// ── Change notification across processes ───────────────────────────

const CHANNEL = 'capabilities:changed';
let pubsub: import('@/db/cache').PubSub | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let debounce: ReturnType<typeof setTimeout> | null = null;

/**
 * Something that decides a capability changed here (a model row, a binding,
 * a voice setting, an install). Refreshes this process and tells the others.
 * Debounced: a burst of writes (assign-all touches every topic) is one refresh.
 */
export function notifyCapabilitiesChanged(): void {
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => {
    debounce = null;
    void refreshCapabilities();
    pubsub?.publish(CHANNEL, { at: Date.now() }).catch((err: unknown) => coreLogger.warn({ err }, 'Could not publish a capability change'));
  }, 50);
  // Never what keeps a process (a script that wrote a model) alive.
  debounce.unref?.();
}

/** Settings whose change can flip a capability. */
const RELEVANT_SETTING = /^(voice\.|mistral\.|openai\.|ollama\.|litellm\.|models\.)/;

/**
 * Boot: compute the first snapshot before anything is served, then keep it
 * current. Idempotent.
 */
export async function initCapabilityGates(): Promise<CapabilitySnapshot> {
  const first = await refreshCapabilities();
  coreLogger.info({ capabilities: Object.fromEntries(CAPABILITIES.map((c) => [c, first[c].on])) }, 'Capability gates ready');
  if (timer) return first;
  timer = setInterval(() => { void refreshCapabilities(); }, 60_000);
  timer.unref?.();
  try {
    const { PubSub } = await import('@/db/cache');
    pubsub = new PubSub();
    await pubsub.subscribe(CHANNEL, () => { void refreshCapabilities(); });
  } catch (err) {
    coreLogger.warn({ err }, 'Capability changes from other processes will arrive by the one-minute refresh only');
  }
  try {
    const { getSettingsService } = await import('@/config/settings-service');
    getSettingsService().onChange((key) => { if (RELEVANT_SETTING.test(key)) notifyCapabilitiesChanged(); });
  } catch (err) {
    coreLogger.warn({ err }, 'Capability gates will not follow setting changes until the next refresh');
  }
  return first;
}

export function stopCapabilityGates(): void {
  if (timer) clearInterval(timer);
  timer = null;
  if (debounce) clearTimeout(debounce);
  debounce = null;
}

// ── Tests ────────────────────────────────────────────────────────────

/** Tests: set capabilities directly (unlisted ones stay as they are). */
export function setCapabilitiesForTest(states: Partial<Record<Capability, boolean>>): void {
  pinnedForTest = true;
  const next = { ...snapshot } as Record<Capability, CapabilityState>;
  for (const [cap, on] of Object.entries(states) as [Capability, boolean][]) {
    next[cap] = on ? { on: true } : { on: false, reason: 'off in test' };
  }
  applySnapshot(next);
}

/** Tests: back to "not checked yet" (everything off). */
export function resetCapabilitiesForTest(): void {
  pinnedForTest = false;
  snapshot = unknownSnapshot();
  computedAt = 0;
}
