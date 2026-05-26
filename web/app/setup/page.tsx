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
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="text-2xl font-semibold">Set up Octipus from your terminal</h1>
      <p className="text-muted-foreground">
        First-run setup happens in the CLI now. Run{' '}
        <code className="rounded bg-muted px-1.5 py-0.5">octi setup</code> on the
        host, then refresh this page or open{' '}
        <a className="underline" href="/chat">
          /chat
        </a>{' '}
        once it finishes.
      </p>
      <p className="text-sm text-muted-foreground">
        Configure providers, channels, and workspace settings from{' '}
        <a className="underline" href="/secrets">
          /secrets
        </a>{' '}
        after you log in.
      </p>
    </main>
  );
}
