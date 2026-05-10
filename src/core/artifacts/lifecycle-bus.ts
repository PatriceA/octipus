/**
 * Lightweight in-process bus for artifact lifecycle events. Decoupled from
 * the gateway event bus (which is for real-time WS subscribers). Hook
 * integrations subscribe here once a `trigger_type` enum migration adds
 * `artifact_*` values; until then this bus is consumed by tests and the
 * hooks manager via direct subscription.
 *
 * View events are sampled at 1/N to avoid spam from busy artifacts.
 */

import { EventEmitter } from 'events';

export interface ArtifactCreatedEvent {
  type: 'artifact:created';
  artifactId: string;
  workspaceId: string;
  createdByUserId: string;
  createdByAgentId: string | null;
}
export interface ArtifactUpdatedEvent {
  type: 'artifact:updated';
  artifactId: string;
  versionId: string;
}
export interface ArtifactDataRefreshedEvent {
  type: 'artifact:data_refreshed';
  artifactId: string;
  sourceName: string;
  snapshotId: string;
}
export interface ArtifactViewedEvent {
  type: 'artifact:viewed';
  artifactId: string;
  viewerUserId: string | null;
}

export type ArtifactLifecycleEvent =
  | ArtifactCreatedEvent
  | ArtifactUpdatedEvent
  | ArtifactDataRefreshedEvent
  | ArtifactViewedEvent;

class LifecycleBus extends EventEmitter {
  private viewSampleRate = 50; // emit 1 of every N views
  private viewCounters = new Map<string, number>();

  emitEvent(ev: ArtifactLifecycleEvent): void {
    if (ev.type === 'artifact:viewed') {
      const c = (this.viewCounters.get(ev.artifactId) ?? 0) + 1;
      this.viewCounters.set(ev.artifactId, c);
      if (c % this.viewSampleRate !== 1) return;
    }
    this.emit(ev.type, ev);
    this.emit('*', ev);
  }

  /** Test-only: change the sample rate. */
  setViewSampleRate(n: number): void {
    this.viewSampleRate = Math.max(1, n);
    this.viewCounters.clear();
  }
}

export const artifactLifecycleBus = new LifecycleBus();
