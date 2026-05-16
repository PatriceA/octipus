'use client';

import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
        <CardTitle>feature status</CardTitle>
        {isFetching && features.length > 0 && (
          <RefreshCw className="ml-auto w-3 h-3 text-on-surface-variant animate-spin" />
        )}
      </CardHeader>
      <CardContent className="p-0">
        {features.length === 0 ? (
          <div className="flex items-center justify-center py-6 text-[12px] text-on-surface-variant gap-2">
            <RefreshCw className="w-3 h-3 animate-spin" />
            loading…
          </div>
        ) : (
          <div className="divide-y divide-outline-variant/40">
            {features.map((feature) => (
              <div
                key={feature.topic}
                className={`flex items-center gap-2.5 px-3 py-2 border-l-2 ${
                  feature.configured ? 'border-l-tertiary/60' : 'border-l-error/60'
                }`}
              >
                <span aria-hidden className={feature.configured ? 'dot dot-ok' : 'dot dot-err'} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] text-on-surface">{feature.name}</span>
                    <span className="text-[10px] uppercase tracking-wider text-outline-variant">
                      {feature.topic}
                    </span>
                  </div>
                  {feature.configured ? (
                    <p className="text-[11px] text-on-surface-variant mt-0.5 truncate">
                      {feature.model}
                    </p>
                  ) : (
                    <p className="text-[11px] text-error mt-0.5 truncate" title={feature.hint}>
                      ! {feature.hint}
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
