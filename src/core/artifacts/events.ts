/**
 * Live-artifact gateway publishers. Channel naming: events use the standard
 * `artifact.*` types and stamp the artifact id on the payload so subscribers
 * can filter by `artifact:<id>` pattern. Snapshot payload is NOT pushed —
 * only the event; the SDK fetches the data via REST.
 */

import { getGatewayHub } from '@/core/gateway/hub';

export function publishArtifactDataUpdated(
  artifactId: string,
  sourceName: string,
  snapshotId: string,
  capturedAt: Date,
): void {
  getGatewayHub().publishEvent({
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
  getGatewayHub().publishEvent({
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
  getGatewayHub().publishEvent({
    type: 'artifact.source_error',
    source: 'artifact-refresh',
    payload: { artifactId, sourceName, error },
  });
}
