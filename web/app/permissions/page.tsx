'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function PermissionsPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/skills');
  }, [router]);

  return (
    <div className="flex items-center justify-center h-64 text-gray-500">
      Redirecting to Skills & Permissions...
    </div>
  );
}
