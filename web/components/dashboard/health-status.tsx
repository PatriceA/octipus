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
  const getStatusDot = (status?: string) => {
    if (!health) {
      return <RefreshCw className="w-4 h-4 text-on-surface-variant animate-spin" />;
    }
    switch (status) {
      case 'healthy':
        return <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />;
      case 'degraded':
        return <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />;
      case 'not_configured':
        return <span className="w-1.5 h-1.5 rounded-full bg-on-surface-variant" />;
      default:
        return <span className="w-1.5 h-1.5 rounded-full bg-error animate-pulse" />;
    }
  };

  const getStatusBg = (status?: string) => {
    if (!health) return 'bg-surface-container-high/50';
    switch (status) {
      case 'healthy':
        return 'bg-surface-container-high/50';
      case 'degraded':
        return 'bg-amber-500/5';
      case 'not_configured':
        return 'bg-surface-container-high/50';
      default:
        return 'bg-error/5';
    }
  };

  const getStatusLabel = (status?: string) => {
    if (!health) return 'Checking...';
    switch (status) {
      case 'healthy':
        return 'Healthy';
      case 'degraded':
        return 'Degraded';
      case 'not_configured':
        return 'Not configured';
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
            <RefreshCw className="w-3.5 h-3.5 text-on-surface-variant animate-spin" />
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
                className={`flex items-center gap-3 p-4 rounded-[0.75rem] transition-colors duration-500 ${getStatusBg(service?.status)}`}
              >
                <div className="flex items-center justify-center w-8 h-8 transition-all duration-500">
                  {getStatusDot(service?.status)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Icon className="w-3.5 h-3.5 text-on-surface-variant shrink-0" />
                    <span className="font-bold text-white text-sm">
                      {label}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[10px] uppercase tracking-widest font-bold text-on-surface-variant">
                      {getStatusLabel(service?.status)}
                    </span>
                    {service?.latency != null && service.latency > 0 && (
                      <span className="text-xs text-on-surface-variant">
                        {service.latency}ms
                      </span>
                    )}
                  </div>
                  {service?.status === 'unhealthy' && service.message && (
                    <p className="text-xs text-error mt-0.5 truncate" title={service.message}>
                      {service.message}
                    </p>
                  )}
                  {service?.status === 'not_configured' && (
                    <p className="text-xs text-on-surface-variant mt-0.5">
                      Optional
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
