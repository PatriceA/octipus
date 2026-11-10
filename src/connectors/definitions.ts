/**
 * The built-in connectors, in one place.
 *
 * A connector is a remote MCP server reached with an OAuth token the user (or
 * a space) grants through dynamic client registration. Everything — the HTTP
 * routes, the OAuth flow, the space connectors and the agent's
 * `connector_list_tools` / `connector_call_tool` — resolves through here:
 * adding a connector is a definition file and one line below.
 *
 * None ship today. The Atlassian and Linear connectors were removed; an
 * install that connected one still holds `connector_<id>_*` vault rows and
 * may have `connector:<id>` in a role's tool list. Those ids no longer
 * resolve here, so every caller ignores them: the registry exposes no tool
 * for them, the token lookup returns null before touching the vault, and the
 * routes answer 404.
 */
import type { ConnectorDefinition } from './types';

export const ALL_CONNECTORS: readonly ConnectorDefinition[] = [];

export function findConnector(id: string): ConnectorDefinition | undefined {
  return ALL_CONNECTORS.find((c) => c.id === id);
}

/** Whether an OAuth `provider` string names a connector rather than an app-level provider. */
export function isConnectorId(id: string): boolean {
  return ALL_CONNECTORS.some((c) => c.id === id);
}
