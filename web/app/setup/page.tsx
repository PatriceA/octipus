'use client';

import {
  ArrowLeft,
  ArrowRight,
  Bot,
  CheckCircle,
  FolderOpen,
  Loader2,
  MessageSquare,
  Server,
  Sparkles,
  UserPlus,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AccountStep } from '@/components/setup/account-step';
import { ChannelsStep } from '@/components/setup/channels-step';
import { DefaultModelStep, LLMProviderStep } from '@/components/setup/llm-step';
import { type StepDefinition, StepIndicator } from '@/components/setup/step-indicator';
import { WorkspaceStep } from '@/components/setup/workspace-step';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

const STEPS: StepDefinition[] = [
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

  // Shared form state
  const [litellmUrl, setLitellmUrl] = useState('http://localhost:4000');
  const [ollamaUrl, setOllamaUrl] = useState('http://localhost:11434');
  const [litellmApiKey, setLitellmApiKey] = useState('');
  const [openrouterApiKey, setOpenrouterApiKey] = useState('');
  const [defaultModel, setDefaultModel] = useState('');
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [telegramToken, setTelegramToken] = useState('');
  const [telegramAllowedUsers, setTelegramAllowedUsers] = useState('');
  const [workspacePath, setWorkspacePath] = useState('./workspace');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
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
        // Settings API may not be available yet -- continue with setup
      }
      setLoading(false);
    };
    checkSetup();
  }, [router, isAuthenticated]);

  const nextStep = () => setCurrentStep((prev) => Math.min(prev + 1, STEPS.length - 1));
  const prevStep = () => setCurrentStep((prev) => Math.max(prev - 1, 0));

  const completeSetup = async () => {
    setSaving(true);
    try {
      await api.post('/settings/setup-complete');
      router.push('/chat');
    } catch {
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

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex flex-col">
      <StepIndicator steps={STEPS} currentStep={currentStep} onStepClick={setCurrentStep} />

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
                <Sparkles className="w-8 h-8 text-primary-700 dark:text-primary-400" />
              </div>
              <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Welcome to Octipus</h2>
              <p className="text-gray-500 dark:text-gray-400 max-w-sm mx-auto">
                Let&apos;s configure your assistant. This will only take a minute.
                You can change all settings later in Settings &gt; Configuration.
              </p>
            </div>
          )}

          {currentStep === 1 && (
            <LLMProviderStep
              litellmUrl={litellmUrl} setLitellmUrl={setLitellmUrl}
              litellmApiKey={litellmApiKey} setLitellmApiKey={setLitellmApiKey}
              ollamaUrl={ollamaUrl} setOllamaUrl={setOllamaUrl}
              openrouterApiKey={openrouterApiKey} setOpenrouterApiKey={setOpenrouterApiKey}
              availableModels={availableModels} setAvailableModels={setAvailableModels}
              saving={saving} setSaving={setSaving} setError={setError}
            />
          )}

          {currentStep === 2 && (
            <DefaultModelStep
              defaultModel={defaultModel} setDefaultModel={setDefaultModel}
              availableModels={availableModels} setAvailableModels={setAvailableModels}
            />
          )}

          {currentStep === 3 && (
            <ChannelsStep
              telegramToken={telegramToken} setTelegramToken={setTelegramToken}
              telegramAllowedUsers={telegramAllowedUsers} setTelegramAllowedUsers={setTelegramAllowedUsers}
              saving={saving} setSaving={setSaving} setError={setError}
            />
          )}

          {currentStep === 4 && (
            <WorkspaceStep
              workspacePath={workspacePath} setWorkspacePath={setWorkspacePath}
              saving={saving} setSaving={setSaving} setError={setError}
            />
          )}

          {currentStep === 5 && (
            <AccountStep
              username={username} setUsername={setUsername}
              password={password} setPassword={setPassword}
              email={email} setEmail={setEmail}
              saving={saving} setSaving={setSaving} setError={setError}
              onCompleteSetup={completeSetup}
            />
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
                className="flex items-center gap-1 px-4 py-1.5 text-sm bg-primary-800 text-white rounded-lg hover:bg-primary-900"
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
