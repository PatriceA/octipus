'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * /admin → redirect to /admin/users (the default landing page).
 */
export default function AdminIndexPage() {
  const router = useRouter();
  useEffect(() => { router.replace('/admin/users'); }, [router]);
  return null;
}
