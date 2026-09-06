/**
 * The built-in connectors, in one place.
 *
 * This list used to be duplicated between the registry and the HTTP route, and
 * every step of the OAuth flow named `atlassian` in a string comparison — so a
 * second connector meant editing seven call sites and hoping none was missed.
 * Everything now resolves through here: adding a connector is a definition
 * file and one line below.
 */
import { ATLASSIAN_CONNECTOR } from './atlassian/definition';
import { LINEAR_CONNECTOR } from './linear/definition';
import type { ConnectorDefinition } from './types';

export const ALL_CONNECTORS: readonly ConnectorDefinition[] = [
  ATLASSIAN_CONNECTOR,
  LINEAR_CONNECTOR,
];

export function findConnector(id: string): ConnectorDefinition | undefined {
  return ALL_CONNECTORS.find((c) => c.id === id);
}

/** Whether an OAuth `provider` string names a connector rather than an app-level provider. */
export function isConnectorId(id: string): boolean {
  return ALL_CONNECTORS.some((c) => c.id === id);
}
