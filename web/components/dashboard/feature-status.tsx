'use client';

import { useQuery } from '@tanstack/react-query';
import { HelpCircle, RefreshCw } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';

interface Feature {
  key: string;
  name: string;
  topic: string;
  /** True when the feature hard-depends on this topic (throws if unbound). */
  required: boolean;
  /** Hover help explaining what the feature does. */
  help: string;
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
          // Two columns — the list got long once OCR/Vision/Memory/Evaluation
          // were split out. Required features (hard deps) are flagged so the
          // user knows which are optional fall-back-to-default topics.
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-px bg-outline-variant/40">
            {features.map((feature) => (
              <div
                key={feature.key}
                className={`flex items-start gap-2.5 px-3 py-2 bg-surface border-l-2 ${
                  feature.configured
                    ? 'border-l-tertiary/60'
                    : feature.required
                    ? 'border-l-error/60'
                    : 'border-l-outline-variant/60'
                }`}
              >
                <span
                  aria-hidden
                  className={`mt-1 ${
                    feature.configured ? 'dot dot-ok' : feature.required ? 'dot dot-err' : 'dot dot-warn'
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[13px] text-on-surface">{feature.name}</span>
                    <span className="text-[10px] uppercase tracking-wider text-outline-variant">
                      {feature.topic}
                    </span>
                    <span
                      className={`text-[9px] uppercase tracking-wider px-1 rounded ${
                        feature.required
                          ? 'bg-error/15 text-error'
                          : 'bg-surface-container-high text-on-surface-variant'
                      }`}
                    >
                      {feature.required ? 'required' : 'optional'}
                    </span>
                    <span
                      title={feature.help}
                      aria-label={feature.help}
                      role="img"
                      tabIndex={0}
                      className="cursor-help text-on-surface-variant/70 focus:outline-none focus:text-on-surface"
                    >
                      <HelpCircle className="w-3 h-3" />
                    </span>
                  </div>
                  {feature.configured ? (
                    <p className="text-[11px] text-on-surface-variant mt-0.5 truncate" title={feature.model ?? undefined}>
                      {feature.model}
                    </p>
                  ) : (
                    <p
                      className={`text-[11px] mt-0.5 truncate ${feature.required ? 'text-error' : 'text-on-surface-variant'}`}
                      title={feature.hint}
                    >
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
