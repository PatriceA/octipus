'use client';

import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { usePageOn } from '@/lib/modules';
import { ADMIN_GROUPS, ADMIN_SECTIONS } from '@/lib/admin-navigation';

export default function AdministrationPage() {
  const pageOn = usePageOn();
  return <div className="admin-overview">{ADMIN_GROUPS.map(group => {
    const sections = ADMIN_SECTIONS.filter(section => section.group === group && pageOn(section.href));
    if (!sections.length) return null;
    return <section key={group} className="admin-overview-group" aria-label={group}>
      <h2>{group}</h2>
      <div className="admin-overview-links">{sections.map(({ href, title, description, icon: Icon }) =>
        <Link href={href} key={href} className="admin-overview-link">
          <span className="admin-overview-icon"><Icon size={20} aria-hidden /></span>
          <span><h3>{title}</h3><p>{description}</p></span>
          <ArrowUpRight size={16} aria-hidden />
        </Link>
      )}</div>
    </section>;
  })}</div>;
}
