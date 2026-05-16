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
      <div className="flex h-screen items-center justify-center bg-background font-mono">
        <div className="flex items-center gap-2 text-on-surface-variant text-[13px]">
          <Loader2 className="w-4 h-4 animate-spin text-primary" />
          <span className="text-primary">❯</span>
          <span>checking setup state<span className="term-caret" /></span>
        </div>
      </div>
    );
  }

  if (setupComplete) return null;

  return (
    <div className="min-h-screen bg-background flex flex-col font-mono">
      <StepIndicator steps={STEPS} currentStep={currentStep} onStepClick={setCurrentStep} />

      <div className="flex-1 flex items-start justify-center px-4 pt-6">
        <div className="w-full max-w-lg term-frame p-6">
          {error && (
            <div className="mb-3 px-2 py-1.5 border border-error/60 bg-error-container/40 rounded-xs text-[12px] text-error">
              ! {error}
            </div>
          )}

          {currentStep === 0 && (
            <div className="text-center space-y-4">
              <div className="inline-flex items-center justify-center w-14 h-14 mx-auto border border-outline-variant rounded-xs bg-surface-container">
                <Sparkles className="w-6 h-6 text-primary" />
              </div>
              <h2 className="text-lg text-on-surface">welcome to octipus</h2>
              <p className="text-[12px] text-on-surface-variant max-w-sm mx-auto leading-relaxed">
                let&apos;s configure your assistant. takes about a minute.
                everything below is also editable from settings &gt; configuration.
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

          <div className="flex justify-between mt-6 pt-4 border-t border-outline-variant/60">
            <button
              onClick={prevStep}
              disabled={currentStep === 0}
              className="flex items-center gap-1 px-2 py-1 text-[12px] text-on-surface-variant hover:text-on-surface disabled:opacity-30 cursor-pointer"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              back
            </button>

            {currentStep < STEPS.length - 1 ? (
              <button
                onClick={nextStep}
                className="flex items-center gap-1.5 px-3 py-1 text-[12px] bg-primary text-on-primary rounded-xs hover:bg-primary-dim cursor-pointer"
              >
                next
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            ) : (
              <button
                onClick={completeSetup}
                disabled={saving}
                className="flex items-center gap-1.5 px-3 py-1 text-[12px] bg-tertiary text-on-tertiary rounded-xs hover:bg-tertiary-dim disabled:opacity-50 cursor-pointer"
              >
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <>❯ finish setup</>}
                {!saving && <CheckCircle className="w-3.5 h-3.5" />}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
