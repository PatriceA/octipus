/**
 * Resolution of a named connector tool against whatever the remote server
 * actually publishes.
 *
 * The whole point of the capability table is surviving a vendor rename, so the
 * tests below feed the same capability three different remote namings and
 * expect the same call each time.
 */
import { describe, expect, it } from 'vitest';
import type { MCPToolDefinition } from '@/mcp/protocol';
import {
  ATLASSIAN_CAPABILITIES,
  CapabilityMappingError,
  capabilitiesFor,
  mapArguments,
  matchRemoteTool,
  normalizeName,
} from './capabilities';

const getIssue = ATLASSIAN_CAPABILITIES.find((c) => c.id === 'jira_get_issue')!;
const search = ATLASSIAN_CAPABILITIES.find((c) => c.id === 'jira_search')!;

function tool(name: string, properties: Record<string, unknown>, required: string[] = []): MCPToolDefinition {
  return {
    name,
    description: name,
    inputSchema: { type: 'object', properties, required },
  } as MCPToolDefinition;
}

describe('normalizeName', () => {
  it('ignores case and separators', () => {
    expect(normalizeName('getJiraIssue')).toBe(normalizeName('get_jira_issue'));
    expect(normalizeName('jira-get-issue')).toBe(normalizeName('jiraGetIssue'));
  });
});

describe('matchRemoteTool', () => {
  it('finds the tool under any of the names the vendor has used', () => {
    for (const name of ['getJiraIssue', 'get_jira_issue', 'jira_get_issue', 'jira_issue']) {
      const found = matchRemoteTool(getIssue, [tool(name, {})]);
      expect(found?.name, name).toBe(name);
    }
  });

  it('prefers the earlier alias when the server publishes several', () => {
    const found = matchRemoteTool(getIssue, [tool('jira_issue', {}), tool('getJiraIssue', {})]);
    expect(found?.name).toBe('getJiraIssue');
  });

  it('returns null when nothing matches', () => {
    expect(matchRemoteTool(getIssue, [tool('somethingElse', {})])).toBeNull();
  });
});

describe('mapArguments', () => {
  it('renames our parameters to the remote property names', () => {
    const remote = tool('getJiraIssue', { issueIdOrKey: {}, cloudId: {} }, ['issueIdOrKey', 'cloudId']);
    expect(mapArguments(getIssue, remote, { issue_key: 'PROJ-1', cloud_id: 'abc' }))
      .toEqual({ issueIdOrKey: 'PROJ-1', cloudId: 'abc' });
  });

  it('maps the same call onto a differently named schema', () => {
    const remote = tool('jira_get_issue', { issue_key: {}, cloud_id: {} }, ['issue_key']);
    expect(mapArguments(getIssue, remote, { issue_key: 'PROJ-1' }))
      .toEqual({ issue_key: 'PROJ-1' });
  });

  it('drops a parameter the remote schema does not declare', () => {
    // A strict server rejects the whole call for one unknown property, so an
    // argument with nowhere to go must not be forwarded.
    const remote = tool('getJiraIssue', { issueIdOrKey: {} }, ['issueIdOrKey']);
    expect(mapArguments(getIssue, remote, { issue_key: 'PROJ-1', cloud_id: 'abc', fields: ['summary'] }))
      .toEqual({ issueIdOrKey: 'PROJ-1' });
  });

  it('omits an empty optional rather than sending a blank', () => {
    const remote = tool('searchJiraIssuesUsingJql', { jql: {}, cloudId: {}, maxResults: {} }, ['jql']);
    expect(mapArguments(search, remote, { jql: 'project = X', cloud_id: '' }))
      .toEqual({ jql: 'project = X' });
  });

  it('names a required property the caller left out', () => {
    const remote = tool('getJiraIssue', { issueIdOrKey: {}, cloudId: {} }, ['issueIdOrKey', 'cloudId']);
    expect(() => mapArguments(getIssue, remote, { issue_key: 'PROJ-1' }))
      .toThrow(CapabilityMappingError);
    expect(() => mapArguments(getIssue, remote, { issue_key: 'PROJ-1' }))
      .toThrow(/requires cloudId/);
  });

  it('says to use the generic tool when a required property has no equivalent', () => {
    const remote = tool('getJiraIssue', { issueIdOrKey: {}, tenantContext: {} }, ['issueIdOrKey', 'tenantContext']);
    expect(() => mapArguments(getIssue, remote, { issue_key: 'PROJ-1' }))
      .toThrow(/connector_call_tool/);
  });

  it('passes arguments through when the server publishes no schema', () => {
    const remote = tool('getJiraIssue', {});
    expect(mapArguments(getIssue, remote, { issue_key: 'PROJ-1' })).toEqual({ issue_key: 'PROJ-1' });
  });
});

describe('the capability table', () => {
  it('declares only atlassian capabilities, each with a unique id', () => {
    const ids = new Set<string>();
    for (const capability of ATLASSIAN_CAPABILITIES) {
      expect(capability.connectorId).toBe('atlassian');
      expect(ids.has(capability.id)).toBe(false);
      ids.add(capability.id);
      expect(capability.aliases.length).toBeGreaterThan(0);
      expect(capability.description.length).toBeGreaterThan(20);
    }
    expect(capabilitiesFor('atlassian')).toHaveLength(ATLASSIAN_CAPABILITIES.length);
    expect(capabilitiesFor('linear')).toHaveLength(0);
  });

  it('covers reading and writing both Jira and Confluence', () => {
    const ids = ATLASSIAN_CAPABILITIES.map((c) => c.id);
    for (const expected of [
      'atlassian_sites',
      'jira_search', 'jira_get_issue', 'jira_create_issue', 'jira_update_issue',
      'jira_comment', 'jira_transition_issue',
      'confluence_search', 'confluence_get_page', 'confluence_create_page', 'confluence_update_page',
    ]) {
      expect(ids, expected).toContain(expected);
    }
  });
});
