/**
 * `federation.mode` and its change event (docs/plans/federation-spec.md §4.2).
 *
 * A mode change applies at once: hot-reload emits it here, and each side
 * subscribes — the host endpoint closes every inbound link when hosting goes
 * off, the visitor link pool every outbound one when visiting does, and the
 * data door reads the mode on every membership check.
 *
 * The per-instance bounds (`federation.maxVisitorsPerInstance` on joins,
 * `federation.maxRemoteTurnsPerInstance` on queued host turns,
 * `federation.agentPostsPerHour` on agent-labelled posts) are read where the
 * host operations enforce them, per call, so a change needs no event.
 */
import { EventEmitter } from 'node:events';
import { type FederationMode, getConfig } from '@/config';

/** Whether members of other installs may join spaces here. */
export function federationHosts(mode: FederationMode = getConfig().federation.mode): boolean {
  return mode === 'host' || mode === 'both';
}

/** Whether members here may join spaces on other installs. */
export function federationVisits(mode: FederationMode = getConfig().federation.mode): boolean {
  return mode === 'visit' || mode === 'both';
}

export type FederationModeListener = (next: FederationMode, previous: FederationMode) => void;

const emitter = new EventEmitter();
// One listener per subsystem; a leak warning at 10 would be noise, not a signal.
emitter.setMaxListeners(50);

/** Subscribe to `federation.mode` changes. Returns the unsubscribe. */
export function onFederationModeChanged(listener: FederationModeListener): () => void {
  emitter.on('change', listener);
  return () => { emitter.off('change', listener); };
}

/**
 * Announce a mode change (hot-reload, after the cached config holds `next`).
 * A listener that throws is its own failure: it is reported and the others
 * still run, so one broken subscriber cannot leave a link open.
 */
export function emitFederationModeChanged(next: FederationMode, previous: FederationMode, onError: (err: unknown) => void): void {
  if (next === previous) return;
  for (const listener of emitter.listeners('change') as FederationModeListener[]) {
    try {
      listener(next, previous);
    } catch (err) {
      onError(err);
    }
  }
}
