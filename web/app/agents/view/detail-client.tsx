'use client';

import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft, Loader2, Square, Trash2,
} from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AgentTimeline } from '@/components/agent-timeline';
import { StatusBadge, type StatusVariant } from '@/components/ui/status-badge';
import { PipelineView } from '@/components/pipeline-view';
import { VerificationEvidence } from '@/components/verification-evidence';
import { useAgentEvents } from '@/hooks/useAgentEvents';
import { api } from '@/lib/api';

interface AgentDetail {
  id: string;
  sessionId: string;
  userId: string;
  topic: string;
  model: string;
  status: string;
  iteration: number;
  createdAt: string;
  metadata: Record<string, unknown>;
}

interface PipelineDetail {
  pipeline: {
    id: string;
    title: string;
    type: string;
    status: string;
    currentStageIndex: number;
  };
  stages: Array<{
    id: string;
    name: string;
    role: string;
    status: string;
    stageIndex: number;
    output?: string;
    error?: string;
  }>;
}

export default function AgentDetailPage() {
  const router = useRouter();
  const agentId = useSearchParams().get('id') ?? '';

  const { events } = useAgentEvents(agentId);

  // Fetch agent details
  const { data: agent, isLoading } = useQuery({
    queryKey: ['agent', agentId],
    queryFn: async () => {
      try {
        return await api.get<AgentDetail>(`/agents/${agentId}`);
      } catch {
        return null;
      }
    },
    refetchInterval: 5000,
  });

  // Fetch pipeline if this agent is an orchestrator for one
  const { data: pipelineData } = useQuery({
    queryKey: ['agent-pipeline', agentId],
    queryFn: async () => {
      try {
        const pipelines = await api.get<{ pipelines: Array<{ id: string; orchestratorAgentId: string }> }>('/pipelines');
        const match = pipelines?.pipelines?.find(
          (p: any) => p.orchestratorAgentId === agentId
        );
        if (match) {
          return api.get<PipelineDetail>(`/pipelines/${match.id}`);
        }
      } catch {
        // No pipeline
      }
      return null;
    },
    refetchInterval: 5000,
  });

  const handleStop = async () => {
    try {
      await api.post(`/agents/${agentId}/stop`);
    } catch (error) {
      console.error('Failed to stop agent:', error);
    }
  };

  const handleRemove = async () => {
    try {
      await api.delete(`/agents/${agentId}`);
      router.push('/agents');
    } catch (error) {
      console.error('Failed to remove agent:', error);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 animate-spin text-on-surface-variant" />
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="space-y-4">
        <button
          onClick={() => router.push('/agents')}
          className="flex items-center gap-2 text-sm text-on-surface-variant hover:text-on-surface"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Agents
        </button>
        <div className="text-center py-12 font-mono">
          <span aria-hidden className="block text-lg text-outline mb-2">?</span>
          <span className="text-[12px] text-on-surface-variant">agent not found</span>
        </div>
      </div>
    );
  }

  const isRunning = agent.status === 'running';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <button
            onClick={() => router.push('/agents')}
            className="flex items-center gap-2 text-sm text-on-surface-variant hover:text-on-surface mb-2"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Agents
          </button>
          <h1 className="text-base font-semibold lowercase font-mono animate-enter">
            <span className="text-outline font-semibold">octi:</span>
            <span className="text-on-surface">~/agents/{agentId.slice(0, 8)}</span>
            <span className="text-primary font-bold"> $</span>
            <span aria-hidden className="term-caret" />
          </h1>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-[12px] font-mono">
            <span>
              <span className="text-on-surface-variant">model </span>
              <span className="text-on-surface">{agent.model}</span>
            </span>
            <span>
              <span className="text-on-surface-variant">topic </span>
              <span className="text-on-surface">{agent.topic}</span>
            </span>
            <span>
              <span className="text-on-surface-variant">created </span>
              <span className="text-on-surface">{new Date(agent.createdAt).toLocaleString()}</span>
            </span>
            <StatusBadge
              variant={
                (isRunning
                  ? 'success'
                  : agent.status === 'completed'
                    ? 'info'
                    : agent.status === 'failed'
                      ? 'danger'
                      : 'neutral') satisfies StatusVariant
              }
              dot
              pulse={isRunning}
            >
              {agent.status}
            </StatusBadge>
            {events.length > 0 && (
              <span className="text-on-surface-variant">
                {events.length} events
              </span>
            )}
          </div>
        </div>
        {isRunning ? (
          <button
            onClick={handleStop}
            className="flex items-center gap-2 px-3 py-2 bg-error text-on-surface rounded-full hover:bg-error-dim text-sm cursor-pointer font-medium"
          >
            <Square className="w-4 h-4" />
            Stop
          </button>
        ) : (
          <button
            onClick={handleRemove}
            className="flex items-center gap-2 px-3 py-2 text-error hover:bg-error/10 rounded-full text-sm cursor-pointer"
          >
            <Trash2 className="w-4 h-4" />
            Remove
          </button>
        )}
      </div>

      {/* Pipeline stepper (if applicable) */}
      {pipelineData?.pipeline && pipelineData.stages && (
        <div className="bg-surface-container rounded-xs border border-outline-variant/10 p-4">
          <h2 className="section-label mb-3">
            pipeline: {pipelineData.pipeline.title}
            <span className="ml-2 normal-case tracking-normal">({pipelineData.pipeline.type})</span>
          </h2>
          <PipelineView
            stages={pipelineData.stages.map(s => ({
              id: s.id,
              name: s.name,
              role: s.role,
              status: s.status as any,
              stageIndex: s.stageIndex,
            }))}
            currentStageIndex={pipelineData.pipeline.currentStageIndex}
          />
        </div>
      )}

      {/* Verification evidence — self-hides when the session ran no checks. */}
      <VerificationEvidence sessionId={agent.sessionId} />

      {/* Event Timeline */}
      <div className="bg-surface-container rounded-xs border border-outline-variant/10">
        <div className="px-4 py-3 border-b border-outline-variant/10">
          <h2 className="section-label">
            event timeline
            <span className="ml-2 normal-case tracking-normal font-normal">
              {events.length} events
            </span>
          </h2>
        </div>
        <AgentTimeline events={events} className="p-4 max-h-[600px]" />
      </div>
    </div>
  );
}
