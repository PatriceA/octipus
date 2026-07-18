'use client';

import { Brain, Clock, Cloud, Compass, Cpu, Database, Globe, Layers, RefreshCw, Rocket, Server, Settings2, Sparkles, Wind, Zap } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface ServiceHealth {
  status: string;
  latency?: number;
  message?: string;
}

interface HealthStatusProps {
  health?: {
    database: ServiceHealth;
    redis: ServiceHealth;
    scheduler: ServiceHealth;
    litellm: ServiceHealth;
    ollama: ServiceHealth;
    openai: ServiceHealth;
    anthropic: ServiceHealth;
    gemini: ServiceHealth;
    vertex: ServiceHealth;
    deepseek: ServiceHealth;
    grok: ServiceHealth;
    mistral: ServiceHealth;
    zai: ServiceHealth;
    moonshot: ServiceHealth;
    voyage: ServiceHealth;
    openrouter: ServiceHealth;
    custom: ServiceHealth;
  };
  isFetching?: boolean;
}

const SERVICE_CONFIG = [
  { key: 'database',   label: 'postgres',   icon: Database },
  { key: 'redis',      label: 'valkey',     icon: Server },
  { key: 'scheduler',  label: 'scheduler',  icon: Clock },
  { key: 'litellm',    label: 'litellm',    icon: Layers },
  { key: 'ollama',     label: 'ollama',     icon: Cpu },
  { key: 'openai',     label: 'openai',     icon: Zap },
  { key: 'anthropic',  label: 'anthropic',  icon: Brain },
  { key: 'gemini',     label: 'gemini',     icon: Sparkles },
  { key: 'vertex',     label: 'vertex',     icon: Cloud },
  { key: 'deepseek',   label: 'deepseek',   icon: Layers },
  { key: 'grok',       label: 'grok',       icon: Rocket },
  { key: 'mistral',    label: 'mistral',    icon: Wind },
  { key: 'zai',        label: 'z.ai',       icon: Sparkles },
  { key: 'moonshot',   label: 'moonshot',   icon: Sparkles },
  { key: 'voyage',     label: 'voyage',     icon: Compass },
  { key: 'openrouter', label: 'openrouter', icon: Globe },
  { key: 'custom',     label: 'custom',     icon: Settings2 },
] as const;

function dotClass(status?: string, hasData?: boolean): string {
  if (!hasData) return 'dot dot-idle';
  switch (status) {
    case 'healthy':        return 'dot dot-ok';
    case 'degraded':       return 'dot dot-warn';
    case 'not_configured': return 'dot dot-idle';
    default:               return 'dot dot-err';
  }
}

function statusLabel(status?: string, hasData?: boolean): string {
  if (!hasData) return 'checking…';
  switch (status) {
    case 'healthy':        return 'ok';
    case 'degraded':       return 'degraded';
    case 'not_configured': return '--';
    default:               return 'down';
  }
}

function rowAccent(status?: string): string {
  switch (status) {
    case 'healthy':        return 'border-l-tertiary/60';
    case 'degraded':       return 'border-l-warning/60';
    case 'not_configured': return 'border-l-outline-variant/40';
    case undefined:        return 'border-l-outline-variant/40';
    default:               return 'border-l-error/60';
  }
}

export function HealthStatus({ health, isFetching }: HealthStatusProps) {
  const hasData = !!health;

  return (
    <Card>
      <CardHeader>
        <CardTitle>system health</CardTitle>
        {isFetching && hasData && (
          <RefreshCw className="ml-auto w-3 h-3 text-on-surface-variant animate-spin" />
        )}
      </CardHeader>
      <CardContent className="p-0">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {SERVICE_CONFIG.map(({ key, label, icon: Icon }, idx) => {
            const service = health?.[key];
            return (
              <div
                key={key}
                className={cn(
                  'flex items-center gap-2.5 px-3 py-2 border-t border-r border-outline-variant/40 border-l-2',
                  rowAccent(service?.status),
                  hasData &&
                    service?.status !== undefined &&
                    !['healthy', 'degraded', 'not_configured'].includes(service.status) &&
                    'glow-err',
                  idx < 4 && 'border-t-0',
                  '[&:nth-child(4n)]:border-r-0',
                )}
              >
                <span aria-hidden className={dotClass(service?.status, hasData)} />
                <Icon className="w-3.5 h-3.5 text-on-surface-variant shrink-0" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-[12px] text-on-surface truncate">{label}</p>
                  <p className="text-[10px] text-on-surface-variant truncate">
                    {statusLabel(service?.status, hasData)}
                    {service?.latency != null && service.latency > 0 && (
                      <span className="ml-1.5 text-outline">· {service.latency}ms</span>
                    )}
                  </p>
                  {service?.status === 'unhealthy' && service.message && (
                    <p className="text-[10px] text-error truncate mt-0.5" title={service.message}>
                      ! {service.message}
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
