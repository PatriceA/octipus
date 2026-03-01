'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft, Bot, Clock, Cpu, Hash, Square, Loader2,
} from 'lucide-react';
import { api } from '@/lib/api';
import { useAgentEvents } from '@/hooks/useAgentEvents';
import { AgentTimeline } from '@/components/agent-timeline';
import { PipelineView } from '@/components/pipeline-view';

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

  const { events, isConnected } = useAgentEvents(agentId);

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

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="space-y-4">
        <button
          onClick={() => router.push('/agents')}
          className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Agents
        </button>
        <div className="text-center py-12 text-gray-500">Agent not found</div>
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
            className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white mb-2"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Agents
          </button>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-3">
            <Bot className="w-6 h-6" />
            Agent {agentId.slice(0, 8)}
          </h1>
          <div className="flex items-center gap-4 mt-2 text-sm text-gray-600 dark:text-gray-400">
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
              isRunning ? 'bg-green-100 text-green-800' :
              agent.status === 'completed' ? 'bg-blue-100 text-blue-800' :
              agent.status === 'failed' ? 'bg-red-100 text-red-800' :
              'bg-gray-100 text-gray-800'
            }`}>
              {isRunning && <Loader2 className="w-3 h-3 animate-spin" />}
              {agent.status}
            </span>
            {events.length > 0 && (
              <span className="text-xs text-gray-400">
                {events.length} events
              </span>
            )}
          </div>
        </div>
        {isRunning && (
          <button
            onClick={handleStop}
            className="flex items-center gap-2 px-3 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 text-sm"
          >
            <Square className="w-4 h-4" />
            Stop
          </button>
        )}
      </div>

      {/* Pipeline stepper (if applicable) */}
      {pipelineData?.pipeline && pipelineData.stages && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-4">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
            Pipeline: {pipelineData.pipeline.title}
            <span className="ml-2 text-xs text-gray-400">({pipelineData.pipeline.type})</span>
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
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700">
        <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
            Event Timeline
            <span className="ml-2 text-xs text-gray-400 font-normal">
              {events.length} events
            </span>
          </h2>
        </div>
        <AgentTimeline events={events} className="p-4 max-h-[600px]" />
      </div>
    </div>
  );
}
