/**
 * Named tools over a remote MCP connector.
 *
 * A connector is a generic pair — `connector_list_tools` then
 * `connector_call_tool` — which costs the model a discovery round-trip and a
 * guess at argument names every time it wants a Jira issue. Named tools remove
 * both. What they must not do is hard-code the remote tool's name: the
 * Atlassian Remote MCP Server owns its own naming and has renamed tools
 * before, and a tool group that silently stops working after a vendor rename
 * is worse than the generic pair it replaced.
 *
 * So a capability declares what it wants, not what it is called: an ordered
 * list of candidate remote names, and per parameter an ordered list of
 * candidate remote property names. Resolution happens against the server's own
 * `tools/list` at call time. When nothing matches, the error names the remote
 * tools that DO exist, which is a thing the model can act on.
 */
import type { MCPToolDefinition } from '@/mcp/protocol';

export interface CapabilityParam {
  /** JSON-schema type advertised on our side. */
  type: string;
  description: string;
  required?: boolean;
  /** Remote property names to try, in order. Our own name is tried first. */
  aliases?: string[];
}

export interface ConnectorCapability {
  /** The tool name we expose. Stable regardless of what the remote calls it. */
  id: string;
  connectorId: string;
  description: string;
  /** Candidate remote tool names, most likely first. */
  aliases: string[];
  params: Record<string, CapabilityParam>;
}

/** Compare names ignoring case and word separators: `getJiraIssue` ~ `get_jira_issue`. */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The remote tool backing a capability, or null when the server has none. */
export function matchRemoteTool(
  capability: ConnectorCapability,
  remoteTools: MCPToolDefinition[],
): MCPToolDefinition | null {
  const byName = new Map(remoteTools.map((tool) => [normalizeName(tool.name), tool]));
  for (const alias of [capability.id, ...capability.aliases]) {
    const found = byName.get(normalizeName(alias));
    if (found) return found;
  }
  return null;
}

interface RemoteSchema {
  properties?: Record<string, unknown>;
  required?: string[];
}

function schemaOf(tool: MCPToolDefinition): RemoteSchema {
  const schema = tool.inputSchema as RemoteSchema | undefined;
  return {
    properties: schema?.properties ?? {},
    required: Array.isArray(schema?.required) ? schema.required : [],
  };
}

export class CapabilityMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapabilityMappingError';
  }
}

/**
 * Translate our arguments into the remote tool's own property names.
 *
 * Anything the remote schema does not declare is dropped rather than passed
 * through: a strict server rejects the whole call for one unknown property,
 * and losing an argument the remote cannot use is better than losing the call.
 * A remote-required property nobody supplied is an error naming it, because
 * that one the model can fix.
 */
export function mapArguments(
  capability: ConnectorCapability,
  remoteTool: MCPToolDefinition,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const { properties, required } = schemaOf(remoteTool);
  const remoteNames = new Map(Object.keys(properties ?? {}).map((name) => [normalizeName(name), name]));

  const mapped: Record<string, unknown> = {};
  const satisfied = new Set<string>();

  for (const [ourName, spec] of Object.entries(capability.params)) {
    const value = args[ourName];
    const candidates = [ourName, ...(spec.aliases ?? [])];
    const remoteName = candidates
      .map((candidate) => remoteNames.get(normalizeName(candidate)))
      .find((name): name is string => name !== undefined);
    if (!remoteName) continue;
    satisfied.add(remoteName);
    if (value === undefined || value === null || value === '') continue;
    mapped[remoteName] = value;
  }

  // A schema with no declared properties (some servers publish none) means we
  // cannot map anything — pass our arguments through untouched rather than
  // sending an empty object.
  if (remoteNames.size === 0) return { ...args };

  const missing = (required ?? []).filter((name) => !(name in mapped));
  if (missing.length > 0) {
    const unmappable = missing.filter((name) => !satisfied.has(name));
    const detail = unmappable.length > 0
      ? `${remoteTool.name} also requires ${unmappable.join(', ')}, which this tool does not expose — use connector_call_tool for that call`
      : `${remoteTool.name} requires ${missing.join(', ')}`;
    throw new CapabilityMappingError(detail);
  }

  return mapped;
}

const CLOUD_ID: CapabilityParam = {
  type: 'string',
  description: 'Atlassian site (cloud) id — get it from atlassian_sites. Required by most calls.',
  aliases: ['cloudId', 'cloud_id', 'siteId'],
};

const ISSUE_KEY: CapabilityParam = {
  type: 'string',
  description: 'Issue key or id, e.g. PROJ-123',
  required: true,
  aliases: ['issueIdOrKey', 'issueKey', 'issueId', 'key', 'issue'],
};

const PAGE_ID: CapabilityParam = {
  type: 'string',
  description: 'Confluence page id',
  required: true,
  aliases: ['pageId', 'page_id', 'id', 'contentId'],
};

/**
 * Jira and Confluence, as the `pm` role thinks about them.
 *
 * The alias lists cover the naming the Atlassian Remote MCP Server has used
 * (camelCase `getJiraIssue`, snake_case `get_jira_issue`, and the shorter
 * `jira_*` forms), so a rename in any of those directions keeps working.
 */
export const ATLASSIAN_CAPABILITIES: ConnectorCapability[] = [
  {
    id: 'atlassian_sites',
    connectorId: 'atlassian',
    description: 'List the Atlassian sites this account can reach, with the cloud id every other call needs. Call this first.',
    aliases: ['getAccessibleAtlassianResources', 'get_accessible_atlassian_resources', 'atlassianUserInfo', 'getVisibleJiraSites'],
    params: {},
  },
  {
    id: 'jira_search',
    connectorId: 'atlassian',
    description: 'Search Jira issues with JQL, e.g. project = PROJ AND status != Done ORDER BY updated DESC.',
    aliases: ['searchJiraIssuesUsingJql', 'search_jira_issues_using_jql', 'jira_search_issues', 'searchJiraIssues', 'jira_search'],
    params: {
      jql: { type: 'string', description: 'A JQL query', required: true, aliases: ['query', 'jqlQuery'] },
      cloud_id: CLOUD_ID,
      max_results: { type: 'number', description: 'Maximum issues to return', aliases: ['maxResults', 'limit'] },
      fields: { type: 'array', description: 'Issue fields to return', aliases: ['fields'] },
    },
  },
  {
    id: 'jira_get_issue',
    connectorId: 'atlassian',
    description: 'Read one Jira issue in full, including its description, status and comments.',
    aliases: ['getJiraIssue', 'get_jira_issue', 'jira_get_issue', 'jira_issue'],
    params: { issue_key: ISSUE_KEY, cloud_id: CLOUD_ID, fields: { type: 'array', description: 'Issue fields to return' } },
  },
  {
    id: 'jira_create_issue',
    connectorId: 'atlassian',
    description: 'Create a Jira issue in a project, with a summary and an optional description.',
    aliases: ['createJiraIssue', 'create_jira_issue', 'jira_create_issue'],
    params: {
      project_key: { type: 'string', description: 'Project key, e.g. PROJ', required: true, aliases: ['projectKey', 'project'] },
      issue_type: { type: 'string', description: 'Issue type name, e.g. Task, Bug, Story', required: true, aliases: ['issueTypeName', 'issueType', 'issuetype', 'type'] },
      summary: { type: 'string', description: 'Issue summary (the title)', required: true },
      description: { type: 'string', description: 'Issue description' },
      cloud_id: CLOUD_ID,
      assignee: { type: 'string', description: 'Assignee account id', aliases: ['assigneeAccountId', 'assignee_account_id'] },
    },
  },
  {
    id: 'jira_update_issue',
    connectorId: 'atlassian',
    description: 'Change fields on an existing Jira issue. Pass `fields` as an object of Jira field names to values.',
    aliases: ['editJiraIssue', 'edit_jira_issue', 'updateJiraIssue', 'jira_update_issue'],
    params: {
      issue_key: ISSUE_KEY,
      fields: { type: 'object', description: 'Jira fields to set, e.g. { "summary": "New title" }', required: true },
      cloud_id: CLOUD_ID,
    },
  },
  {
    id: 'jira_comment',
    connectorId: 'atlassian',
    description: 'Add a comment to a Jira issue.',
    aliases: ['addCommentToJiraIssue', 'add_comment_to_jira_issue', 'jira_add_comment'],
    params: {
      issue_key: ISSUE_KEY,
      body: { type: 'string', description: 'Comment text', required: true, aliases: ['commentBody', 'comment', 'text'] },
      cloud_id: CLOUD_ID,
    },
  },
  {
    id: 'jira_transition_issue',
    connectorId: 'atlassian',
    description: 'Move a Jira issue to another status. Use jira_get_issue first to see which transitions are available.',
    aliases: ['transitionJiraIssue', 'transition_jira_issue', 'jira_transition_issue'],
    params: {
      issue_key: ISSUE_KEY,
      transition: { type: 'string', description: 'Transition id or name', required: true, aliases: ['transitionId', 'transition_id', 'status'] },
      cloud_id: CLOUD_ID,
    },
  },
  {
    id: 'jira_list_projects',
    connectorId: 'atlassian',
    description: 'List the Jira projects visible to this account.',
    aliases: ['getVisibleJiraProjects', 'get_visible_jira_projects', 'jira_get_projects', 'listJiraProjects'],
    params: {
      cloud_id: CLOUD_ID,
      query: { type: 'string', description: 'Filter projects by name or key', aliases: ['searchString', 'search'] },
    },
  },
  {
    id: 'confluence_search',
    connectorId: 'atlassian',
    description: 'Search Confluence with CQL, e.g. text ~ "onboarding" AND space = ENG.',
    aliases: ['searchConfluenceUsingCql', 'search_confluence_using_cql', 'confluence_search'],
    params: {
      cql: { type: 'string', description: 'A CQL query', required: true, aliases: ['query'] },
      cloud_id: CLOUD_ID,
      limit: { type: 'number', description: 'Maximum pages to return', aliases: ['maxResults'] },
    },
  },
  {
    id: 'confluence_get_page',
    connectorId: 'atlassian',
    description: 'Read one Confluence page, including its body.',
    aliases: ['getConfluencePage', 'get_confluence_page', 'confluence_get_page'],
    params: { page_id: PAGE_ID, cloud_id: CLOUD_ID },
  },
  {
    id: 'confluence_create_page',
    connectorId: 'atlassian',
    description: 'Create a Confluence page in a space, optionally nested under a parent page.',
    aliases: ['createConfluencePage', 'create_confluence_page', 'confluence_create_page'],
    params: {
      space_id: { type: 'string', description: 'Space id or key', required: true, aliases: ['spaceId', 'spaceKey', 'space'] },
      title: { type: 'string', description: 'Page title', required: true },
      body: { type: 'string', description: 'Page body (markdown or storage format)', required: true, aliases: ['content', 'bodyMarkdown'] },
      parent_id: { type: 'string', description: 'Parent page id, to nest the page', aliases: ['parentId'] },
      cloud_id: CLOUD_ID,
    },
  },
  {
    id: 'confluence_update_page',
    connectorId: 'atlassian',
    description: 'Update a Confluence page. Read it first — the update needs the next version number.',
    aliases: ['updateConfluencePage', 'update_confluence_page', 'confluence_update_page'],
    params: {
      page_id: PAGE_ID,
      title: { type: 'string', description: 'New page title' },
      body: { type: 'string', description: 'New page body', aliases: ['content', 'bodyMarkdown'] },
      version: { type: 'number', description: 'The new version number (current + 1)', aliases: ['versionNumber'] },
      cloud_id: CLOUD_ID,
    },
  },
];

/** Every capability declared for one connector. */
export function capabilitiesFor(connectorId: string): ConnectorCapability[] {
  return ATLASSIAN_CAPABILITIES.filter((c) => c.connectorId === connectorId);
}
