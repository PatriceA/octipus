'use client';

import { CheckCircle, XCircle, AlertCircle, RefreshCw, Database, Server, Layers } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';

interface ServiceHealth {
  status: string;
  latency?: number;
  message?: string;
}

interface HealthStatusProps {
  health?: {
    database: ServiceHealth;
    redis: ServiceHealth;
    litellm: ServiceHealth;
  };
  isFetching?: boolean;
}

const SERVICE_CONFIG = [
  { key: 'database', label: 'PostgreSQL', icon: Database, description: 'Primary database' },
  { key: 'redis', label: 'Redis', icon: Server, description: 'Cache & sessions' },
  { key: 'litellm', label: 'LiteLLM', icon: Layers, description: 'Model proxy (Ollama, OpenAI, etc.)' },
] as const;

export function HealthStatus({ health, isFetching }: HealthStatusProps) {
  const getStatusIcon = (status?: string) => {
    if (!health) {
      return <RefreshCw className="w-5 h-5 text-gray-500 animate-spin" />;
    }
    switch (status) {
      case 'healthy':
        return <CheckCircle className="w-5 h-5 text-green-500" />;
      case 'degraded':
        return <AlertCircle className="w-5 h-5 text-yellow-500" />;
      default:
        return <XCircle className="w-5 h-5 text-red-500" />;
    }
  };

  const getStatusColor = (status?: string) => {
    if (!health) return 'bg-gray-50 dark:bg-gray-700/50';
    switch (status) {
      case 'healthy':
        return 'bg-gray-50 dark:bg-gray-700/50';
      case 'degraded':
        return 'bg-yellow-50/50 dark:bg-yellow-900/10';
      default:
        return 'bg-red-50/50 dark:bg-red-900/10';
    }
  };

  const getStatusLabel = (status?: string) => {
    if (!health) return 'Checking...';
    switch (status) {
      case 'healthy':
        return 'Healthy';
      case 'degraded':
        return 'Degraded';
      default:
        return 'Unhealthy';
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>System Health</CardTitle>
          {isFetching && health && (
            <RefreshCw className="w-4 h-4 text-gray-500 animate-spin" />
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {SERVICE_CONFIG.map(({ key, label, icon: Icon, description }) => {
            const service = health?.[key];
            return (
              <div
                key={key}
                className={`flex items-center gap-3 p-3 rounded-lg transition-colors duration-500 ${getStatusColor(service?.status)}`}
              >
                <div className="transition-all duration-500">
                  {getStatusIcon(service?.status)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Icon className="w-3.5 h-3.5 text-gray-500 shrink-0" />
                    <span className="font-medium text-gray-900 dark:text-gray-100 text-sm">
                      {label}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      {getStatusLabel(service?.status)}
                    </span>
                    {service?.latency != null && service.latency > 0 && (
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        {service.latency}ms
                      </span>
                    )}
                  </div>
                  {service?.status === 'unhealthy' && service.message && (
                    <p className="text-xs text-red-500 dark:text-red-400 mt-0.5 truncate" title={service.message}>
                      {service.message}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
