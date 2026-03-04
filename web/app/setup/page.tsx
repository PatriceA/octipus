'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import {
  Loader2,
  CheckCircle,
  XCircle,
  ArrowRight,
  ArrowLeft,
  Server,
  Bot,
  MessageSquare,
  FolderOpen,
  UserPlus,
  Sparkles,
  Eye,
  EyeOff,
} from 'lucide-react';

const STEPS = [
  { id: 'welcome', label: 'Welcome', icon: Sparkles },
  { id: 'llm', label: 'LLM Provider', icon: Server },
  { id: 'model', label: 'Default Model', icon: Bot },
  { id: 'channels', label: 'Channels', icon: MessageSquare },
  { id: 'workspace', label: 'Workspace', icon: FolderOpen },
  { id: 'account', label: 'Admin Account', icon: UserPlus },
];

export default function SetupPage() {
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const [currentStep, setCurrentStep] = useState(0);
  const [loading, setLoading] = useState(true);
  const [setupComplete, setSetupComplete] = useState(false);

  // Form state
  const [litellmUrl, setLitellmUrl] = useState('http://localhost:4000');
  const [ollamaUrl, setOllamaUrl] = useState('http://localhost:11434');
  const [litellmApiKey, setLitellmApiKey] = useState('');
  const [defaultModel, setDefaultModel] = useState('');
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [telegramToken, setTelegramToken] = useState('');
  const [telegramAllowedUsers, setTelegramAllowedUsers] = useState('');
  const [workspacePath, setWorkspacePath] = useState('./workspace');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Check if setup is already complete
  useEffect(() => {
    const checkSetup = async () => {
      try {
        const res = await api.get<{ setupComplete: boolean }>('/settings/setup-status');
        if (res.setupComplete) {
          setSetupComplete(true);
          router.replace(isAuthenticated ? '/chat' : '/login');
        }
      } catch {
        // Settings API may not be available yet — continue with setup
      }
      setLoading(false);
    };
    checkSetup();
  }, [router, isAuthenticated]);

  const nextStep = () => setCurrentStep((prev) => Math.min(prev + 1, STEPS.length - 1));
  const prevStep = () => setCurrentStep((prev) => Math.max(prev - 1, 0));

  const testLLMConnection = async () => {
    setTestResult(null);
    try {
      const res = await api.get<{ healthy: boolean; models?: string[] }>('/health/litellm');
      if (res.healthy) {
        setTestResult({ success: true, message: 'Connected successfully!' });
        if (res.models?.length) {
          setAvailableModels(res.models);
        }
      } else {
        setTestResult({ success: false, message: 'Connection failed' });
      }
    } catch {
      setTestResult({ success: false, message: 'Could not reach LiteLLM. Make sure the service is running.' });
    }
  };

  const fetchModels = async () => {
    try {
      const res = await api.get<{ models: { modelId: string; name: string }[] }>('/models');
      if (res.models?.length) {
        setAvailableModels(res.models.map(m => m.modelId));
      }
    } catch {
      // Models may not be configured yet
    }
  };

  const saveLLMSettings = async () => {
    setSaving(true);
    setError('');
    try {
      const settings: Record<string, unknown> = {
        'litellm.proxyUrl': litellmUrl,
        'ollama.url': ollamaUrl,
      };
      await api.put('/settings/batch', { settings });

      if (litellmApiKey) {
        await api.put(`/settings/${encodeURIComponent('litellm.apiKey')}`, { value: litellmApiKey });
      }
    } catch (err) {
      setError((err as Error).message);
    }
    setSaving(false);
  };

  const saveChannelSettings = async () => {
    setSaving(true);
    setError('');
    try {
      if (telegramToken) {
        await api.put(`/settings/${encodeURIComponent('telegram.botToken')}`, { value: telegramToken });
      }
      if (telegramAllowedUsers) {
        await api.put(`/settings/${encodeURIComponent('telegram.allowedUsers')}`, {
          value: telegramAllowedUsers.split(',').map(s => s.trim()).filter(Boolean),
        });
      }
    } catch (err) {
      setError((err as Error).message);
    }
    setSaving(false);
  };

  const saveWorkspaceSettings = async () => {
    setSaving(true);
    setError('');
    try {
      await api.put(`/settings/${encodeURIComponent('workspace.rootPath')}`, { value: workspacePath });
    } catch (err) {
      setError((err as Error).message);
    }
    setSaving(false);
  };

  const createAccount = async () => {
    if (!username || !password) return;
    setSaving(true);
    setError('');
    try {
      const res = await api.post<{ token?: string; error?: string }>('/auth/register', {
        username,
        password,
        email: email || undefined,
      });
      if (res.error) {
        setError(res.error);
      } else if (res.token) {
        api.setToken(res.token);
      }
    } catch (err) {
      setError((err as Error).message);
    }
    setSaving(false);
  };

  const completeSetup = async () => {
    setSaving(true);
    try {
      await api.post('/settings/setup-complete');
      router.push('/chat');
    } catch {
      // If not authenticated, redirect to login
      router.push('/login');
    }
    setSaving(false);
  };

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-50 dark:bg-gray-950">
        <Loader2 className="w-8 h-8 animate-spin text-primary-500" />
      </div>
    );
  }

  if (setupComplete) return null;

  const inputClasses = 'w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-sm focus:ring-2 focus:ring-primary-500';

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex flex-col">
      {/* Progress bar */}
      <div className="w-full bg-gray-200 dark:bg-gray-800 h-1">
        <div
          className="bg-primary-600 h-1 transition-all duration-300"
          style={{ width: `${((currentStep + 1) / STEPS.length) * 100}%` }}
        />
      </div>

      {/* Step indicators */}
      <div className="flex justify-center gap-4 py-6">
        {STEPS.map((step, i) => (
          <button
            key={step.id}
            onClick={() => setCurrentStep(i)}
            className={`flex items-center gap-1.5 text-xs font-medium transition-colors ${
              i <= currentStep
                ? 'text-primary-600 dark:text-primary-400'
                : 'text-gray-400 dark:text-gray-600'
            }`}
          >
            {i < currentStep ? (
              <CheckCircle className="w-4 h-4" />
            ) : (
              <step.icon className="w-4 h-4" />
            )}
            <span className="hidden sm:inline">{step.label}</span>
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 flex items-start justify-center px-4 pt-4">
        <div className="w-full max-w-lg bg-white dark:bg-gray-800/90 rounded-xl shadow-sm ring-1 ring-gray-200/60 dark:ring-gray-700/60 p-8">
          {error && (
            <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            </div>
          )}

          {/* Step: Welcome */}
          {currentStep === 0 && (
            <div className="text-center space-y-4">
              <div className="w-16 h-16 mx-auto rounded-2xl bg-primary-100 dark:bg-primary-950/40 flex items-center justify-center">
                <Sparkles className="w-8 h-8 text-primary-600 dark:text-primary-400" />
              </div>
              <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Welcome to Assistant</h2>
              <p className="text-gray-500 dark:text-gray-400 max-w-sm mx-auto">
                Let's configure your assistant. This will only take a minute.
                You can change all settings later in Settings &gt; Configuration.
              </p>
            </div>
          )}

          {/* Step: LLM Provider */}
          {currentStep === 1 && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">LLM Provider</h2>
              <p className="text-sm text-gray-500">Configure your LLM proxy or Ollama instance.</p>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">LiteLLM URL</label>
                <input
                  type="text"
                  value={litellmUrl}
                  onChange={(e) => setLitellmUrl(e.target.value)}
                  placeholder="http://localhost:4000"
                  className={inputClasses}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">LiteLLM API Key (optional)</label>
                <input
                  type="password"
                  value={litellmApiKey}
                  onChange={(e) => setLitellmApiKey(e.target.value)}
                  placeholder="sk-..."
                  className={inputClasses}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Ollama URL</label>
                <input
                  type="text"
                  value={ollamaUrl}
                  onChange={(e) => setOllamaUrl(e.target.value)}
                  placeholder="http://localhost:11434"
                  className={inputClasses}
                />
              </div>

              <div className="flex gap-2">
                <button
                  onClick={testLLMConnection}
                  className="px-4 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300"
                >
                  Test Connection
                </button>
                <button
                  onClick={saveLLMSettings}
                  disabled={saving}
                  className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50"
                >
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save'}
                </button>
              </div>

              {testResult && (
                <div className={`flex items-center gap-2 text-sm ${testResult.success ? 'text-green-600' : 'text-red-600'}`}>
                  {testResult.success ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
                  {testResult.message}
                </div>
              )}
            </div>
          )}

          {/* Step: Default Model */}
          {currentStep === 2 && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Default Model</h2>
              <p className="text-sm text-gray-500">
                Select or enter the default model. You can add more models later in the Models page.
              </p>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Model ID</label>
                <input
                  type="text"
                  value={defaultModel}
                  onChange={(e) => setDefaultModel(e.target.value)}
                  placeholder="e.g. qwen3:14b, gpt-4o"
                  className={inputClasses}
                  list="model-suggestions"
                />
                {availableModels.length > 0 && (
                  <datalist id="model-suggestions">
                    {availableModels.map(m => <option key={m} value={m} />)}
                  </datalist>
                )}
              </div>

              <button
                onClick={fetchModels}
                className="text-sm text-primary-600 hover:text-primary-700 dark:text-primary-400"
              >
                Refresh available models
              </button>

              {availableModels.length > 0 && (
                <div>
                  <p className="text-xs text-gray-500 mb-2">Available models:</p>
                  <div className="flex flex-wrap gap-1">
                    {availableModels.slice(0, 10).map(m => (
                      <button
                        key={m}
                        onClick={() => setDefaultModel(m)}
                        className={`px-2 py-1 text-xs rounded-lg border transition-colors ${
                          defaultModel === m
                            ? 'bg-primary-50 border-primary-300 text-primary-700 dark:bg-primary-950/40 dark:border-primary-700 dark:text-primary-300'
                            : 'border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
                        }`}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Step: Channels */}
          {currentStep === 3 && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Channels (Optional)</h2>
              <p className="text-sm text-gray-500">Connect messaging channels. You can skip this and configure later.</p>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Telegram Bot Token</label>
                <input
                  type="password"
                  value={telegramToken}
                  onChange={(e) => setTelegramToken(e.target.value)}
                  placeholder="123456:ABC-DEF..."
                  className={inputClasses}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Telegram Allowed Users (optional)</label>
                <input
                  type="text"
                  value={telegramAllowedUsers}
                  onChange={(e) => setTelegramAllowedUsers(e.target.value)}
                  placeholder="user_id_1, user_id_2"
                  className={inputClasses}
                />
                <p className="text-xs text-gray-500 mt-1">Comma-separated Telegram user IDs. Leave empty to allow all users.</p>
              </div>

              {(telegramToken) && (
                <button
                  onClick={saveChannelSettings}
                  disabled={saving}
                  className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50"
                >
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save Channel Settings'}
                </button>
              )}
            </div>
          )}

          {/* Step: Workspace */}
          {currentStep === 4 && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Workspace</h2>
              <p className="text-sm text-gray-500">Set the root directory the agent can access.</p>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Workspace Root Path</label>
                <input
                  type="text"
                  value={workspacePath}
                  onChange={(e) => setWorkspacePath(e.target.value)}
                  placeholder="./workspace"
                  className={`${inputClasses} font-mono`}
                />
              </div>

              <button
                onClick={saveWorkspaceSettings}
                disabled={saving}
                className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save'}
              </button>
            </div>
          )}

          {/* Step: Admin Account */}
          {currentStep === 5 && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Create Admin Account</h2>
              <p className="text-sm text-gray-500">
                The first registered user becomes the admin. If you already have an account, skip this step.
              </p>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Username</label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="admin"
                  className={inputClasses}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Choose a strong password"
                  className={inputClasses}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Email (optional)</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="admin@example.com"
                  className={inputClasses}
                />
              </div>

              <div className="flex gap-2">
                {username && password && (
                  <button
                    onClick={createAccount}
                    disabled={saving}
                    className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50"
                  >
                    {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Create Account'}
                  </button>
                )}
                <button
                  onClick={completeSetup}
                  disabled={saving}
                  className="px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 flex items-center gap-2"
                >
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Complete Setup'}
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          {/* Navigation */}
          <div className="flex justify-between mt-8 pt-4 border-t border-gray-200 dark:border-gray-700">
            <button
              onClick={prevStep}
              disabled={currentStep === 0}
              className="flex items-center gap-1 px-3 py-1.5 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 disabled:opacity-30"
            >
              <ArrowLeft className="w-4 h-4" />
              Back
            </button>

            {currentStep < STEPS.length - 1 ? (
              <button
                onClick={nextStep}
                className="flex items-center gap-1 px-4 py-1.5 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700"
              >
                Next
                <ArrowRight className="w-4 h-4" />
              </button>
            ) : (
              <button
                onClick={completeSetup}
                disabled={saving}
                className="flex items-center gap-1 px-4 py-1.5 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Finish Setup'}
                <CheckCircle className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
