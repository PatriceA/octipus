'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Security</h2>

      <div className="space-y-4">
        <div className="flex items-center justify-between p-4 bg-gray-50 dark:bg-gray-700/50 rounded-lg">
          <div>
            <h3 className="font-medium text-gray-900 dark:text-gray-100">Two-Factor Authentication (TOTP)</h3>
            <p className="text-sm text-gray-500">
              {profile?.totpEnabled
                ? 'Your account is protected with 2FA'
                : 'Add an extra layer of security'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`px-2 py-0.5 text-xs rounded-full ${
                profile?.totpEnabled
                  ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                  : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
              }`}
            >
              {profile?.totpEnabled ? 'Enabled' : 'Disabled'}
            </span>
            {!profile?.totpEnabled && !setupData && (
              <button
                onClick={handleSetup}
                disabled={loading}
                className="px-3 py-1.5 text-xs bg-primary-800 text-white cursor-pointer rounded-lg hover:bg-primary-900 disabled:opacity-50"
              >
                {loading ? 'Setting up...' : 'Enable 2FA'}
              </button>
            )}
          </div>
        </div>

        {/* TOTP Setup Flow */}
        {setupData && (
          <div className="p-4 border border-blue-200 dark:border-blue-800 rounded-lg space-y-4">
            <h4 className="font-medium text-gray-900 dark:text-gray-100">Scan this QR code with your authenticator app</h4>
            {setupData.qrCode && (
              <div className="flex justify-center p-4 bg-white rounded-lg">
                <img src={setupData.qrCode} alt="TOTP QR Code" className="w-48 h-48" />
              </div>
            )}
            <div>
              <p className="text-xs text-gray-500 mb-1">Or enter this secret manually:</p>
              <code className="block px-3 py-2 bg-gray-100 dark:bg-gray-700 rounded text-sm font-mono break-all dark:text-gray-100">
                {setupData.secret}
              </code>
            </div>
            {setupData.backupCodes && setupData.backupCodes.length > 0 && (
              <div>
                <p className="text-xs text-gray-500 mb-1">Save these backup codes somewhere safe:</p>
                <div className="grid grid-cols-2 gap-1 px-3 py-2 bg-gray-100 dark:bg-gray-700 rounded font-mono text-sm">
                  {setupData.backupCodes.map((code, i) => (
                    <span key={i} className="dark:text-gray-100">{code}</span>
                  ))}
                </div>
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Enter 6-digit code to verify
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={verifyCode}
                  onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="000000"
                  className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-center font-mono text-lg tracking-widest"
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
              className="text-sm text-gray-500 hover:text-gray-700"
            >
              Cancel
            </button>
          </div>
        )}

        {/* Disable 2FA */}
        {profile?.totpEnabled && (
          <div className="p-4 ring-1 ring-gray-200/60 dark:ring-gray-700/60 rounded-xl">
            <h4 className="font-medium text-gray-900 dark:text-gray-100 mb-2">Disable 2FA</h4>
            <div className="flex gap-2">
              <input
                type="text"
                value={disableCode}
                onChange={(e) => setDisableCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="Enter TOTP code"
                className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 font-mono"
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
          <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          </div>
        )}

        <div className="p-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
          <p className="text-sm text-yellow-800 dark:text-yellow-200">
            Security keys and session tokens are managed server-side. Contact an admin for password resets.
          </p>
        </div>
      </div>
    </div>
  );
}
