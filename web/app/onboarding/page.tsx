'use client';

import { OnboardingGuide } from '@/components/onboarding/onboarding-guide';
import { PageHeader } from '@/components/ui/page-header';

/** The setup guide on its own page, to set up more after the first time. */
export default function OnboardingPage() {
  return (
    <div className="onboarding-workspace mx-auto w-full max-w-4xl space-y-6 font-sans">
      <PageHeader title="Welcome to Octipus" description="Connect an AI model, try your first chat, then add what you need." />
      <OnboardingGuide variant="page" />
    </div>
  );
}
