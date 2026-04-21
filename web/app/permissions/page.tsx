'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

export default function PermissionsPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/tools');
  }, [router]);

  return (
    <div className="flex items-center justify-center h-64 text-on-surface-variant">
      Redirecting to Tools & Permissions...
    </div>
  );
}
