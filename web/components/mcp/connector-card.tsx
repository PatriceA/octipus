'use client';

import { CheckCircle, ExternalLink, Loader2, Unplug } from 'lucide-react';
import Image from 'next/image';
import { useState } from 'react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

interface ConnectorCardProps {
  id: string;
  name: string;
  description: string;
  logoUrl: string;
  connected: boolean;
  expiresAt?: string;
  onStatusChange: () => void;
}

export function ConnectorCard({
  id,
  name,
  description,
  logoUrl,
  connected,
  onStatusChange,
}: ConnectorCardProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleConnect = async () => {
    setLoading(true);
    setError('');
    try {
      const { url } = await api.post<{ url: string }>(`/connectors/${id}/authorize`, {});

      const popup = window.open(url, `${name} OAuth`, 'width=600,height=700,scrollbars=yes');
      if (!popup) {
        setError('Popup blocked. Allow popups for this page and try again.');
        setLoading(false);
        return;
      }

      const handler = (event: MessageEvent) => {
        if (event.origin !== window.location.origin) return;
        const data = event.data as { type?: string; connectorId?: string; error?: string };
        if (data?.connectorId !== id) return;

        if (data.type === 'connector:connected') {
          onStatusChange();
        } else if (data.type === 'connector:error') {
          setError(data.error ?? 'OAuth failed');
        }
        window.removeEventListener('message', handler);
        setLoading(false);
      };

      window.addEventListener('message', handler);

      const pollClosed = setInterval(() => {
        if (popup.closed) {
          clearInterval(pollClosed);
          window.removeEventListener('message', handler);
          setLoading(false);
          onStatusChange();
        }
      }, 500);
    } catch (err) {
      setError((err as Error).message);
      setLoading(false);
    }
  };

  const handleDisconnect = async () => {
    setLoading(true);
    setError('');
    try {
      await api.delete(`/connectors/${id}`);
      onStatusChange();
    } catch (err) {
      setError((err as Error).message);
    }
    setLoading(false);
  };

  return (
    <div className="bg-surface-container rounded-xs ring-1 ring-outline-variant/10 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-surface-container-low flex items-center justify-center shrink-0 overflow-hidden">
            <Image
              src={logoUrl}
              alt={name}
              width={32}
              height={32}
              className="object-contain"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
            />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-medium text-on-surface">{name}</h3>
              {connected && (
                <span className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-green-900/30 text-tertiary">
                  <CheckCircle className="w-3 h-3" />
                  connected
                </span>
              )}
            </div>
            <p className="text-xs text-on-surface-variant mt-0.5">{description}</p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0 ml-3">
          {loading ? (
            <Loader2 className="w-4 h-4 animate-spin text-on-surface-variant" />
          ) : connected ? (
            <button
              onClick={handleDisconnect}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-on-surface-variant hover:text-error hover:bg-red-900/20 rounded-lg cursor-pointer transition-colors"
            >
              <Unplug className="w-3.5 h-3.5" />
              Disconnect
            </button>
          ) : (
            <button
              onClick={handleConnect}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary text-on-surface rounded-lg hover:bg-primary-dim cursor-pointer transition-colors"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              Connect
            </button>
          )}
        </div>
      </div>

      {error && <p className="mt-2 text-xs text-error">{error}</p>}
    </div>
  );
}
