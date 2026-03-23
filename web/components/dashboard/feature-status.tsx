'use client';

import { useQuery } from '@tanstack/react-query';
import { Cpu, RefreshCw } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { api } from '@/lib/api';

interface Feature {
  name: string;
  topic: string;
  configured: boolean;
  model?: string | null;
  hint?: string;
}

export function FeatureStatus() {
  const { data, isFetching } = useQuery({
    queryKey: ['feature-status'],
    queryFn: async () => {
      try {
        return await api.get<{ features: Feature[] }>('/health/features');
      } catch {
        return null;
      }
    },
    refetchInterval: 30000,
  });

  const features = data?.features || [];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Cpu className="w-4 h-4 text-on-surface-variant" />
            <CardTitle>Feature Status</CardTitle>
          </div>
          {isFetching && features.length > 0 && (
            <RefreshCw className="w-3.5 h-3.5 text-on-surface-variant animate-spin" />
          )}
        </div>
      </CardHeader>
      <CardContent>
        {features.length === 0 ? (
          <div className="flex items-center justify-center py-4">
            <RefreshCw className="w-4 h-4 text-on-surface-variant animate-spin" />
          </div>
        ) : (
          <div className="space-y-3">
            {features.map((feature) => (
              <div
                key={feature.topic}
                className="flex items-center gap-3 px-4 py-3 rounded-[0.75rem] bg-surface-container-high/50"
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    feature.configured ? 'bg-emerald-400' : 'bg-error'
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-white text-sm">
                      {feature.name}
                    </span>
                    <span className="text-[10px] uppercase tracking-widest font-bold text-on-surface-variant">
                      {feature.topic}
                    </span>
                  </div>
                  {feature.configured ? (
                    <p className="text-xs text-on-surface-variant mt-0.5 truncate">
                      {feature.model}
                    </p>
                  ) : (
                    <p className="text-xs text-error/80 mt-0.5 truncate" title={feature.hint}>
                      {feature.hint}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
