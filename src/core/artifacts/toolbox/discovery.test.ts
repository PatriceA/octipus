/**
 * Integration smoke test — the auto-discovery scan should pick up every
 * collector shipped in Phase 1 and register them. Bun runs in the repo
 * cwd, so the discovery scan walks the real `collectors/` folder.
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { discoverToolbox } from './discovery';
import { _resetToolboxRegistryForTests, getToolboxRegistry } from './registry';

describe('discoverToolbox', () => {
  beforeEach(() => { _resetToolboxRegistryForTests(); });
  afterEach(() => { _resetToolboxRegistryForTests(); });

  test('registers all collectors (phases 1 + 3)', async () => {
    await discoverToolbox();
    const ids = getToolboxRegistry().list({ family: 'collect' }).map((e) => e.id);
    expect(ids).toContain('art_collect_http_json');
    expect(ids).toContain('art_collect_http_text');
    expect(ids).toContain('art_collect_rss');
    expect(ids).toContain('art_collect_octipus_tool');
    expect(ids).toContain('art_collect_mcp');
    expect(ids).toContain('art_collect_html_scrape');
  });

  test('registers all transforms (phases 2 + 3)', async () => {
    await discoverToolbox();
    const ids = getToolboxRegistry().list({ family: 'transform' }).map((e) => e.id);
    expect(ids).toContain('art_transform_jsonpath');
    expect(ids).toContain('art_transform_filter');
    expect(ids).toContain('art_transform_sort');
    expect(ids).toContain('art_transform_top_n');
    expect(ids).toContain('art_transform_group_count');
    expect(ids).toContain('art_transform_diff');
  });

  test('registers all widgets (phases 2 + 3)', async () => {
    await discoverToolbox();
    const ids = getToolboxRegistry().list({ family: 'widget' }).map((e) => e.id);
    expect(ids).toContain('art_widget_table');
    expect(ids).toContain('art_widget_list');
    expect(ids).toContain('art_widget_kpi_card');
    expect(ids).toContain('art_widget_markdown');
    expect(ids).toContain('art_widget_json_tree');
    expect(ids).toContain('art_widget_bar_chart');
    expect(ids).toContain('art_widget_pie_chart');
    expect(ids).toContain('art_widget_heatmap');
    expect(ids).toContain('art_widget_mermaid');
  });

  test('registers all exporters (phase 3)', async () => {
    await discoverToolbox();
    const ids = getToolboxRegistry().list({ family: 'export' }).map((e) => e.id);
    expect(ids).toContain('art_export_csv');
    expect(ids).toContain('art_export_json');
    expect(ids).toContain('art_export_markdown');
  });

  test('is idempotent', async () => {
    await discoverToolbox();
    const before = getToolboxRegistry().list().length;
    await discoverToolbox();
    expect(getToolboxRegistry().list().length).toBe(before);
  });

  test('every registered tool has the expected manifest shape', async () => {
    await discoverToolbox();
    for (const entry of getToolboxRegistry().list()) {
      const d = getToolboxRegistry().describe(entry.id);
      expect(d).not.toBeNull();
      expect(d!.description.length).toBeGreaterThan(0);
      expect(d!.returns.length).toBeGreaterThan(0);
    }
  });
});
