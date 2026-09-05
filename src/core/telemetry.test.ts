import { describe, expect, test } from 'vitest';
import {
  recordChannelMessage,
  recordClassification,
  recordLlmRequest,
  recordRootRun,
  recordSwarmSpawn,
  recordToolExecution,
  registry,
  renderMetrics,
} from './telemetry';

/** Pull a single metric line by exact prefix from the exposition text. */
function line(text: string, needle: string): string | undefined {
  return text.split('\n').find((l) => l.startsWith(needle) && !l.startsWith('#'));
}

describe('telemetry exposition (WS4)', () => {
  test('preserves the legacy health/build gauge names', async () => {
    const out = await renderMetrics(1, 0);
    expect(out).toContain('octipus_up 1');
    expect(out).toContain('# TYPE process_resident_memory_bytes gauge');
    expect(out).toContain('nodejs_heap_used_bytes');
    expect(line(out, 'octipus_db_up')).toBe('octipus_db_up 1');
    expect(line(out, 'octipus_storage_up')).toBe('octipus_storage_up 0');
  });

  test('build_info carries the version label without stacking on re-render', async () => {
    await renderMetrics(1, 1);
    const out = await renderMetrics(1, 1);
    const infoLines = out.split('\n').filter((l) => l.startsWith('octipus_build_info'));
    // reset() before set() means exactly one series regardless of scrape count.
    expect(infoLines.length).toBe(1);
    expect(infoLines[0]).toContain('version=');
  });

  test('domain counters increment with their labels', async () => {
    recordRootRun('slack', 'task', 'success');
    recordClassification('coding', 'deterministic');
    recordToolExecution('read_file', 'success', 0.2);
    recordToolExecution('read_file', 'error', 0.1);
    recordLlmRequest('ollama', 'llama3', 'success', 1.5, { prompt: 120, completion: 40 });
    recordSwarmSpawn('research', 2);
    recordSwarmSpawn('research', 2, true);
    recordChannelMessage('telegram', 'inbound');

    const out = await renderMetrics(1, 1);
    expect(out).toContain('octipus_root_agent_runs_total{channel="slack",role="task",status="success"} 1');
    expect(out).toContain('octipus_classifications_total{topic="coding",method="deterministic"} 1');
    expect(out).toContain('octipus_tool_executions_total{tool="read_file",status="success"} 1');
    expect(out).toContain('octipus_tool_executions_total{tool="read_file",status="error"} 1');
    expect(out).toContain('octipus_llm_tokens_total{provider="ollama",model="llama3",direction="prompt"} 120');
    expect(out).toContain('octipus_llm_tokens_total{provider="ollama",model="llama3",direction="completion"} 40');
    expect(out).toContain('octipus_swarm_spawns_total{role="research",depth="2",planned="false"} 1');
    expect(out).toContain('octipus_swarm_spawns_total{role="research",depth="2",planned="true"} 1');
    expect(out).toContain('octipus_channel_messages_total{channel="telegram",direction="inbound"} 1');
  });

  test('record helpers never throw on odd input (they swallow errors)', () => {
    expect(() => recordToolExecution('', 'success', Number.NaN)).not.toThrow();
    expect(() => recordLlmRequest(undefined, undefined, 'error', 0)).not.toThrow();
    expect(() => recordRootRun(undefined, undefined, 'error')).not.toThrow();
  });

  test('histograms register their _bucket/_count/_sum series', async () => {
    recordToolExecution('write_file', 'success', 0.5);
    const out = await renderMetrics(1, 1);
    expect(out).toContain('octipus_tool_execution_duration_seconds_bucket');
    expect(out).toContain('octipus_tool_execution_duration_seconds_count');
    expect(out).toContain('octipus_llm_request_duration_seconds_bucket');
    // sanity: the shared registry is the one the route renders from
    expect(registry).toBeDefined();
  });
});
