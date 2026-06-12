/**
 * Legacy `/setup` route — first-run onboarding moved to the CLI
 * (`octi setup`). When the system is already set up we redirect
 * straight to the chat. Otherwise we show a one-paragraph hint
 * pointing the user to the terminal wizard. There is no longer a
 * web-based onboarding flow.
 */

import { redirect } from 'next/navigation';

async function fetchSetupStatus(): Promise<{ setupComplete: boolean } | null> {
  try {
    const base = process.env.OCTIPUS_API_URL || 'http://localhost:3005';
    const res = await fetch(`${base}/api/settings/setup-status`, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as { setupComplete: boolean };
  } catch {
    return null;
  }
}

export default async function SetupRedirectPage() {
  const status = await fetchSetupStatus();
  if (status?.setupComplete) {
    redirect('/chat');
  }
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-4 p-8 text-center font-mono animate-enter">
      <h1 className="text-base font-semibold lowercase">
        <span className="text-outline font-semibold">octi:</span>
        <span className="text-on-surface">~/setup</span>
        <span className="text-primary font-bold"> $</span>
        <span aria-hidden className="term-caret" />
      </h1>
      <p className="text-[13px] text-on-surface-variant">
        first-run setup happens in the CLI now. run{' '}
        <code className="term-shell rounded-xs bg-surface-container-high px-1.5 py-0.5 text-on-surface">octi setup</code> on the
        host, then refresh this page or open{' '}
        <a className="text-primary hover:underline" href="/chat">
          /chat
        </a>{' '}
        once it finishes.
      </p>
      <p className="text-[12px] text-on-surface-variant">
        configure providers, channels, and workspace settings from{' '}
        <a className="text-primary hover:underline" href="/secrets">
          /secrets
        </a>{' '}
        after you log in.
      </p>
    </main>
  );
}
