'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import type { UserProfile } from '@/lib/types/settings';

export function SecurityTab() {
  const queryClient = useQueryClient();
  const { data: profile } = useQuery({
    queryKey: ['profile'],
    queryFn: () => api.get<UserProfile>('/auth/me'),
  });

  const [setupData, setSetupData] = useState<{ qrCode?: string; secret?: string; backupCodes?: string[] } | null>(null);
  const [verifyCode, setVerifyCode] = useState('');
  const [disableCode, setDisableCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSetup = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.post<{ qrCode: string; secret: string; backupCodes: string[] }>('/auth/totp/setup');
      setSetupData(data);
    } catch (err) {
      setError((err as Error).message);
    }
    setLoading(false);
  };

  const handleVerify = async () => {
    if (verifyCode.length !== 6) return;
    setLoading(true);
    setError('');
    try {
      await api.post('/auth/totp/enable', { code: verifyCode });
      setSetupData(null);
      setVerifyCode('');
      queryClient.invalidateQueries({ queryKey: ['profile'] });
    } catch (err) {
      setError((err as Error).message);
    }
    setLoading(false);
  };

  const handleDisable = async () => {
    if (disableCode.length !== 6) return;
    setLoading(true);
    setError('');
    try {
      await api.post('/auth/totp/disable', { code: disableCode });
      setDisableCode('');
      queryClient.invalidateQueries({ queryKey: ['profile'] });
    } catch (err) {
      setError((err as Error).message);
    }
    setLoading(false);
  };

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-extrabold tracking-tighter text-white">Security</h2>

      <div className="space-y-4">
        <div className="flex items-center justify-between p-4 bg-[#131313] rounded-lg">
          <div>
            <h3 className="font-medium text-white">Two-Factor Authentication (TOTP)</h3>
            <p className="text-sm text-on-surface-variant">
              {profile?.totpEnabled
                ? 'Your account is protected with 2FA'
                : 'Add an extra layer of security'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`px-2 py-0.5 text-xs rounded-full ${
                profile?.totpEnabled
                  ? 'bg-green-900/30 text-green-300'
                  : 'bg-[#262626] text-on-surface-variant'
              }`}
            >
              {profile?.totpEnabled ? 'Enabled' : 'Disabled'}
            </span>
            {!profile?.totpEnabled && !setupData && (
              <button
                onClick={handleSetup}
                disabled={loading}
                className="px-3 py-1.5 text-xs bg-primary text-[#0e0e0e] cursor-pointer rounded-lg hover:bg-primary-container disabled:opacity-50"
              >
                {loading ? 'Setting up...' : 'Enable 2FA'}
              </button>
            )}
          </div>
        </div>

        {/* TOTP Setup Flow */}
        {setupData && (
          <div className="p-4 border border-outline-variant/10 rounded-lg space-y-4">
            <h4 className="font-medium text-white">Scan this QR code with your authenticator app</h4>
            {setupData.qrCode && (
              <div className="flex justify-center p-4 bg-white rounded-lg">
                <img src={setupData.qrCode} alt="TOTP QR Code" className="w-48 h-48" />
              </div>
            )}
            <div>
              <p className="text-xs text-on-surface-variant mb-1">Or enter this secret manually:</p>
              <code className="block px-3 py-2 bg-[#262626] rounded text-sm font-mono break-all text-white">
                {setupData.secret}
              </code>
            </div>
            {setupData.backupCodes && setupData.backupCodes.length > 0 && (
              <div>
                <p className="text-xs text-on-surface-variant mb-1">Save these backup codes somewhere safe:</p>
                <div className="grid grid-cols-2 gap-1 px-3 py-2 bg-[#262626] rounded font-mono text-sm">
                  {setupData.backupCodes.map((code, i) => (
                    <span key={i} className="text-white">{code}</span>
                  ))}
                </div>
              </div>
            )}
            <div>
              <label className="text-xs font-bold text-on-surface-variant uppercase mb-2 block">
                Enter 6-digit code to verify
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={verifyCode}
                  onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="000000"
                  className="flex-1 bg-[#262626] border-none rounded-md py-3 px-4 text-white text-center font-mono text-lg tracking-widest focus:ring-1 focus:ring-primary"
                />
                <button
                  onClick={handleVerify}
                  disabled={loading || verifyCode.length !== 6}
                  className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
                >
                  Verify
                </button>
              </div>
            </div>
            <button
              onClick={() => { setSetupData(null); setVerifyCode(''); }}
              className="text-sm text-on-surface-variant hover:text-white"
            >
              Cancel
            </button>
          </div>
        )}

        {/* Disable 2FA */}
        {profile?.totpEnabled && (
          <div className="p-4 bg-[#131313] rounded-[1rem]">
            <h4 className="font-medium text-white mb-2">Disable 2FA</h4>
            <div className="flex gap-2">
              <input
                type="text"
                value={disableCode}
                onChange={(e) => setDisableCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="Enter TOTP code"
                className="flex-1 bg-[#262626] border-none rounded-md py-3 px-4 text-white font-mono focus:ring-1 focus:ring-primary"
              />
              <button
                onClick={handleDisable}
                disabled={loading || disableCode.length !== 6}
                className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
              >
                Disable
              </button>
            </div>
          </div>
        )}

        {error && (
          <div className="p-3 bg-error-dim/10 border border-error-dim/20 rounded-lg">
            <p className="text-sm text-error">{error}</p>
          </div>
        )}

        <div className="p-4 bg-amber-900/20 border border-amber-800/30 rounded-lg">
          <p className="text-sm text-amber-200">
            Security keys and session tokens are managed server-side. Contact an admin for password resets.
          </p>
        </div>
      </div>
    </div>
  );
}
