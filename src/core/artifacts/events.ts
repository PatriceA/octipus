/**
 * Live-artifact gateway publishers. Each event goes to the resource
 * `artifact:<id>` only — connections that passed the artifact access check
 * (the owner's, or an `artifact_token` viewer of that artifact) — never by
 * user and never to the whole install. The payload still carries the
 * artifact id for the SDK. Snapshot payload is NOT pushed — only the event;
 * the SDK fetches the data via REST.
 */

import { randomBytes } from 'crypto';
import { getGatewayHub } from '@/core/gateway/hub';
import type { GlobalGatewayEvent } from '@/core/gateway/protocol';

function publishToArtifact(
  artifactId: string,
  event: Pick<GlobalGatewayEvent, 'type' | 'source' | 'payload'>,
): void {
  getGatewayHub().publishToResource(`artifact:${artifactId}`, {
    type: 'event',
    event: { ...event, id: randomBytes(12).toString('hex'), timestamp: Date.now() },
  });
}

export function publishArtifactDataUpdated(
  artifactId: string,
  sourceName: string,
  snapshotId: string,
  capturedAt: Date,
): void {
  publishToArtifact(artifactId, {
    type: 'artifact.data_updated',
    source: 'artifact-refresh',
    payload: {
      artifactId,
      sourceName,
      snapshotId,
      capturedAt: capturedAt.toISOString(),
    },
  });
}

export function publishArtifactVersionUpdated(artifactId: string, versionId: string): void {
  publishToArtifact(artifactId, {
    type: 'artifact.version_updated',
    source: 'artifact-api',
    payload: { artifactId, versionId },
  });
}

export function publishArtifactSourceError(
  artifactId: string,
  sourceName: string,
  error: string,
): void {
  publishToArtifact(artifactId, {
    type: 'artifact.source_error',
    source: 'artifact-refresh',
    payload: { artifactId, sourceName, error },
  });
}
