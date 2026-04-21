'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/** Recurring tasks are now part of the Hooks page (Scheduled Tasks tab) */
export default function TasksPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/hooks');
  }, [router]);
  return null;
}
