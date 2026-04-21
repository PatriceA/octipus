'use client';

import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft, Bot, Clock, Cpu, Hash, Loader2, Square, Trash2,
} from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { AgentTimeline } from '@/components/agent-timeline';
import { PipelineView } from '@/components/pipeline-view';
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
  const params = useParams();
  const router = useRouter();
  const agentId = params.id as string;

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
          className="flex items-center gap-2 text-sm text-on-surface-variant hover:text-white"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Agents
        </button>
        <div className="text-center py-12 text-on-surface-variant">Agent not found</div>
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
            className="flex items-center gap-2 text-sm text-on-surface-variant hover:text-white mb-2"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Agents
          </button>
          <h1 className="text-4xl lg:text-5xl font-extrabold tracking-tighter text-white flex items-center gap-3">
            <Bot className="w-6 h-6" />
            Agent {agentId.slice(0, 8)}
          </h1>
          <div className="flex items-center gap-4 mt-2 text-sm text-on-surface-variant">
            <span className="flex items-center gap-1">
              <Cpu className="w-4 h-4" />
              {agent.model}
            </span>
            <span className="flex items-center gap-1">
              <Hash className="w-4 h-4" />
              {agent.topic}
            </span>
            <span className="flex items-center gap-1">
              <Clock className="w-4 h-4" />
              {new Date(agent.createdAt).toLocaleString()}
            </span>
            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
              isRunning ? 'bg-emerald-500/10 text-emerald-400' :
              agent.status === 'completed' ? 'bg-primary/10 text-primary' :
              agent.status === 'failed' ? 'bg-error/10 text-error' :
              'bg-on-surface-variant/10 text-on-surface-variant'
            }`}>
              {isRunning && <Loader2 className="w-3 h-3 animate-spin" />}
              {agent.status}
            </span>
            {events.length > 0 && (
              <span className="text-xs text-on-surface-variant">
                {events.length} events
              </span>
            )}
          </div>
        </div>
        {isRunning ? (
          <button
            onClick={handleStop}
            className="flex items-center gap-2 px-3 py-2 bg-error text-white rounded-full hover:bg-error-dim text-sm cursor-pointer font-medium"
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
        <div className="bg-surface-container rounded-[1rem] border border-outline-variant/10 p-4">
          <h2 className="text-sm font-semibold text-on-surface-variant mb-3">
            Pipeline: {pipelineData.pipeline.title}
            <span className="ml-2 text-xs text-on-surface-variant">({pipelineData.pipeline.type})</span>
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

      {/* Event Timeline */}
      <div className="bg-surface-container rounded-[1rem] border border-outline-variant/10">
        <div className="px-4 py-3 border-b border-outline-variant/10">
          <h2 className="text-sm font-semibold text-on-surface-variant">
            Event Timeline
            <span className="ml-2 text-xs text-on-surface-variant font-normal">
              {events.length} events
            </span>
          </h2>
        </div>
        <AgentTimeline events={events} className="p-4 max-h-[600px]" />
      </div>
    </div>
  );
}
