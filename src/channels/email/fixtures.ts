/**
 * Raw mails for the email channel's tests: a plain mail from an
 * authenticated sender unless told otherwise.
 */
export interface TestMail {
  from?: string;
  id?: string;
  subject?: string;
  body?: string;
  html?: string;
  /** The `Authentication-Results` value; null for none. */
  auth?: string | null;
  inReplyTo?: string;
  references?: string;
  /** Further header lines, written above the rest. */
  extra?: string[];
  /** Header lines written below `Authentication-Results` (as a sender could). */
  below?: string[];
}

export const TRUSTED_ID = 'mx.octipus.test';

export function rawMail(m: TestMail = {}): Buffer {
  const from = m.from ?? 'Ann <ann@example.com>';
  const auth = m.auth === undefined ? `${TRUSTED_ID}; spf=pass smtp.mailfrom=example.com; dkim=pass header.d=example.com; dmarc=pass (p=reject) header.from=example.com` : m.auth;
  const lines = [
    ...(m.extra ?? []),
    ...(auth === null ? [] : [`Authentication-Results: ${auth}`]),
    ...(m.below ?? []),
    'Received: from mail.example.com by mx.octipus.test; Mon, 23 Nov 2026 10:00:00 +0000',
    `From: ${from}`,
    'To: octipus@company.test',
    `Subject: ${m.subject ?? 'Summarise the Q3 report'}`,
    `Message-ID: ${m.id ?? `<${Math.random().toString(36).slice(2)}@example.com>`}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo}`] : []),
    ...(m.references ? [`References: ${m.references}`] : []),
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
  ];
  if (m.html !== undefined) {
    lines.push('Content-Type: text/html; charset=utf-8', '', m.html);
  } else {
    lines.push('Content-Type: text/plain; charset=utf-8', '', m.body ?? 'What were the main numbers?');
  }
  return Buffer.from(`${lines.join('\r\n')}\r\n`);
}
