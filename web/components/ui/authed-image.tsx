'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

/**
 * An `<img>` for content behind the API's auth.
 *
 * A note that embeds `![shot](/api/documents/<id>/raw)` cannot be rendered by a
 * plain `<img src>` in every deployment octipus supports: in the browser the
 * API is same-origin through the Next rewrite so the session cookie is sent,
 * but the Tauri desktop client points at an arbitrary remote backend and
 * authenticates with a bearer token that `<img>` never attaches. Fetching the
 * bytes through the API client and rendering an object URL is correct in both,
 * so there is no deployment branch to get wrong.
 *
 * Absolute `http(s)` sources are left to the browser — they are not ours to
 * authenticate, and proxying them through the API client would leak the user's
 * credentials to a third-party host.
 */
export function AuthedImage({ src, alt, title }: { src: string; alt?: string; title?: string }) {
  const isApiPath = src.startsWith('/api/');
  // One state object keyed by the src it belongs to. Keeping the key inside the
  // state (rather than resetting via `setState` when `src` changes) is what lets
  // the effect body stay side-effect-free — the React Compiler lint rejects a
  // `setState` call made directly in an effect, and a stale-src result is
  // filtered on read instead.
  const [result, setResult] = useState<{ src: string; url: string | null; failed: boolean } | null>(null);

  useEffect(() => {
    if (!isApiPath) return;
    let cancelled = false;
    let url: string | null = null;
    api
      .getBlob(src.slice('/api'.length))
      .then((blob) => {
        // The effect may have been cleaned up while the fetch was in flight;
        // creating the URL then would leak it (nothing left to revoke it).
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setResult({ src, url, failed: false });
      })
      .catch(() => {
        if (!cancelled) setResult({ src, url: null, failed: true });
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [src, isApiPath]);

  const current = result?.src === src ? result : null;
  const failed = current?.failed ?? false;
  const objectUrl = current?.url ?? null;

  if (failed) {
    return (
      <span className="inline-block rounded-xs border border-outline-variant/40 px-2 py-1 text-[12px] text-on-surface-variant">
        image unavailable{alt ? ` — ${alt}` : ''}
      </span>
    );
  }

  const resolved = isApiPath ? objectUrl : src;
  if (!resolved) {
    return (
      <span className="inline-block rounded-xs bg-surface-container-high px-2 py-1 text-[12px] text-on-surface-variant/70">
        loading image…
      </span>
    );
  }

  // Plain <img>, not next/image: the source is an object URL or a remote host,
  // neither of which the optimizer can process (and this app static-exports).
  return (
    <img
      src={resolved}
      alt={alt ?? ''}
      title={title}
      className="max-w-full h-auto rounded-xs border border-outline-variant/20 my-2"
    />
  );
}
