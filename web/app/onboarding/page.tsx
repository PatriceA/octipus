'use client';

import { OnboardingGuide } from '@/components/onboarding/onboarding-guide';
import { PageHeader } from '@/components/ui/page-header';

/** The setup guide on its own page, to set up more after the first time. */
export default function OnboardingPage() {
  return (
    <div className="space-y-6 max-w-4xl">
      <PageHeader title="set up" description="tell Octipus what you use it for, and it does the settings for you." />
      <OnboardingGuide variant="page" />
    </div>
  );
}
