'use client';

import { Check, Copy, Loader2, QrCode, RefreshCw, Smartphone } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';

interface PairingData {
  code: string;
  expiresIn: number;
  serverUrl?: string;
  publicUrl?: string;
}

export function MobileTab() {
  const [pairing, setPairing] = useState<PairingData | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const generateCode = async () => {
    setLoading(true);
    setError(null);
    setPairing(null);
    setQrDataUrl(null);

    try {
      const data = await api.post<PairingData>('/devices/pair/generate', {});
      if (!data?.code) throw new Error('No pairing code returned');

      setPairing(data);
      setSecondsLeft(data.expiresIn);

      // QR contains LAN URL for local pairing + public URL for remote access after pairing
      const backendUrl = data.serverUrl
        || (typeof window !== 'undefined'
          ? `${window.location.protocol}//${window.location.hostname}:3005`
          : 'http://localhost:3005');

      const qrPayload = JSON.stringify({
        url: backendUrl,
        code: data.code,
        ...(data.publicUrl ? { publicUrl: data.publicUrl } : {}),
      });
      const dataUrl = await QRCode.toDataURL(qrPayload, {
        width: 280,
        margin: 2,
        color: { dark: '#ffffff', light: '#00000000' },
      });
      setQrDataUrl(dataUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate pairing code');
    } finally {
      setLoading(false);
    }
  };

  // Countdown timer
  useEffect(() => {
    if (secondsLeft <= 0) {
      if (timerRef.current) clearInterval(timerRef.current);
      return;
    }
    timerRef.current = setInterval(() => {
      setSecondsLeft((prev) => {
        if (prev <= 1) {
          setPairing(null);
          setQrDataUrl(null);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [secondsLeft]);

  const copyCode = () => {
    if (!pairing) return;
    navigator.clipboard.writeText(pairing.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const minutes = Math.floor(secondsLeft / 60);
  const seconds = secondsLeft % 60;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-on-surface flex items-center gap-2">
          <Smartphone className="w-5 h-5" />
          Mobile App
        </h2>
        <p className="text-sm text-on-surface-variant mt-1">
          Connect the mobile app to this assistant by scanning a QR code.
        </p>
      </div>

      <div className="bg-surface-container rounded-xl p-6 border border-outline-variant/10">
        <h3 className="text-sm font-medium text-on-surface mb-4">Pair Device</h3>

        {!pairing && !loading && (
          <div className="text-center py-8">
            <QrCode className="w-16 h-16 text-on-surface-variant/30 mx-auto mb-4" />
            <p className="text-sm text-on-surface-variant mb-4">
              Generate a QR code to pair your mobile device. The code expires after 5 minutes.
            </p>
            <button
              onClick={generateCode}
              className="px-4 py-2 bg-primary text-on-primary rounded-lg hover:opacity-90 font-medium text-sm inline-flex items-center gap-2"
            >
              <QrCode className="w-4 h-4" />
              Generate QR Code
            </button>
          </div>
        )}

        {loading && (
          <div className="text-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-primary mx-auto" />
            <p className="text-sm text-on-surface-variant mt-2">Generating pairing code...</p>
          </div>
        )}

        {pairing && qrDataUrl && (
          <div className="text-center">
            <div className="inline-block p-4 bg-surface-container-highest rounded-2xl mb-4">
              <img src={qrDataUrl} alt="Pairing QR Code" width={280} height={280} />
            </div>

            <p className="text-sm text-on-surface-variant mb-2">
              Scan this QR code with the mobile app
            </p>

            <div className="flex items-center justify-center gap-2 mb-4">
              <span className={`text-xs font-mono px-2 py-1 rounded ${
                secondsLeft < 60 ? 'bg-red-900/20 text-error' : 'bg-surface-container-highest text-on-surface-variant'
              }`}>
                Expires in {minutes}:{seconds.toString().padStart(2, '0')}
              </span>

              <button
                onClick={copyCode}
                className="text-xs px-2 py-1 rounded bg-surface-container-highest text-on-surface-variant hover:text-on-surface inline-flex items-center gap-1"
                title="Copy pairing code"
              >
                {copied ? <Check className="w-3 h-3 text-tertiary" /> : <Copy className="w-3 h-3" />}
                {copied ? 'Copied' : 'Code'}
              </button>
            </div>

            <button
              onClick={generateCode}
              className="text-xs text-on-surface-variant hover:text-on-surface inline-flex items-center gap-1"
            >
              <RefreshCw className="w-3 h-3" />
              Generate new code
            </button>
          </div>
        )}

        {error && (
          <div className="mt-4 p-3 bg-red-900/10 border border-red-900/20 rounded-lg">
            <p className="text-sm text-error">{error}</p>
          </div>
        )}
      </div>

      <div className="bg-surface-container rounded-xl p-6 border border-outline-variant/10">
        <h3 className="text-sm font-medium text-on-surface mb-2">How to pair</h3>
        <ol className="text-sm text-on-surface-variant space-y-2 list-decimal list-inside">
          <li>Open the mobile app on your Android device</li>
          <li>The app will show a QR scanner on first launch</li>
          <li>Click "Generate QR Code" above</li>
          <li>Point your phone camera at the QR code</li>
          <li>The app will connect automatically</li>
        </ol>
      </div>

      <div className="bg-surface-container rounded-xl p-6 border border-outline-variant/10">
        <h3 className="text-sm font-medium text-on-surface mb-2">Remote Access</h3>
        <p className="text-sm text-on-surface-variant">
          By default, pairing works over your local network. To use the mobile app outside your home network,
          set your public URL on the <strong className="text-on-surface">Integrations</strong> tab
          (field: <strong className="text-on-surface">Public URL for OAuth callbacks</strong>).
          The QR code will then include the public URL so the app can connect remotely.
        </p>
      </div>
    </div>
  );
}
