'use client';

import { Download, Volume2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { dataUrlToBlob, mediaFileName, sessionFileApiPath, type TurnMedia } from '@/lib/turn-media';

/**
 * The media a turn made for the person (an image `generate_image` drew,
 * speech `speak` made), under the answer: image thumbnails that open in the
 * in-chat file view, an audio player, and a download link for each.
 *
 * The path is an absolute path in the session's workspace, behind the API's
 * auth, so the bytes come through the session files API (`GET
 * /sessions/:id/files?path=`, the route the file view reads) via the API
 * client — a plain `src` would carry no bearer token in the desktop client
 * (see `AuthedImage`). What it returns is shown as an object URL.
 */

// The route returns bytes (a `dataUrl`) for images and audio up to 10 MB;
// anything larger comes back as `too-large` and shows as unavailable.
type FileResponse =
  | { type: 'image'; dataUrl: string; mimeType: string }
  | { type: 'audio'; dataUrl: string; mimeType: string }
  | { type: 'binary' }
  | { type: 'too-large'; size: number }
  | { type: 'text' }
  | { type: 'directory' };

function unavailableReason(kind: TurnMedia['kind'], res: FileResponse | null | undefined): string {
  if (res?.type === 'too-large') return 'too large to show here';
  return kind === 'audio' ? 'cannot be played in the browser yet' : 'cannot be shown here';
}

/**
 * An object URL for the media's bytes, or why there is none. The result is
 * keyed by the file it belongs to (as `AuthedImage` does), so a stale result
 * is filtered on read and the effect never sets state synchronously.
 */
function useSessionMediaUrl(sessionId: string, path: string, kind: TurnMedia['kind']): { url: string | null; error: string | null } {
  const key = `${sessionId}\n${path}`;
  const [result, setResult] = useState<{ key: string; url: string | null; error: string | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    api
      .get<FileResponse>(sessionFileApiPath(sessionId, path))
      .then((res) => {
        if (cancelled) return;
        const blob = res && 'dataUrl' in res && typeof res.dataUrl === 'string' ? dataUrlToBlob(res.dataUrl) : null;
        if (!blob) {
          setResult({ key, url: null, error: unavailableReason(kind, res) });
          return;
        }
        url = URL.createObjectURL(blob);
        setResult({ key, url, error: null });
      })
      .catch(() => {
        if (!cancelled) setResult({ key, url: null, error: 'unavailable' });
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [key, sessionId, path, kind]);

  const current = result?.key === key ? result : null;
  return { url: current?.url ?? null, error: current?.error ?? null };
}

function DownloadLink({ url, name }: { url: string; name: string }) {
  return (
    <a
      href={url}
      download={name}
      className="inline-flex items-center gap-0.5 text-primary hover:underline"
      aria-label={`Download ${name}`}
    >
      <Download className="h-3 w-3" aria-hidden="true" />
      Download
    </a>
  );
}

function Status({ children, error }: { children: string; error?: boolean }) {
  return (
    <span className={error
      ? 'inline-block rounded-xs border border-outline-variant/40 px-2 py-1 text-[12px] text-on-surface-variant'
      : 'inline-block rounded-xs bg-surface-container-high px-2 py-1 text-[12px] text-on-surface-variant/70'}
    >
      {children}
    </span>
  );
}

function TurnImage({ media, sessionId, onOpenFile }: { media: TurnMedia; sessionId: string; onOpenFile?: (path: string) => void }) {
  const { url, error } = useSessionMediaUrl(sessionId, media.path, media.kind);
  const name = mediaFileName(media);
  const thumb = url && (
    // Plain <img>: the source is an object URL, which no optimizer can process.
    <img src={url} alt={name} className="h-40 max-w-[16rem] object-cover" />
  );
  const frame = 'block overflow-hidden rounded-lg border border-outline-variant/30 hover:border-primary/60 focus-visible:outline-2 focus-visible:outline-primary';
  return (
    <figure className="flex flex-col gap-1" data-testid="turn-media-image" data-path={media.path}>
      {thumb ? (
        onOpenFile ? (
          <button type="button" onClick={() => onOpenFile(media.path)} title={`Open ${name}`} aria-label={`Open ${name}`} className={frame}>
            {thumb}
          </button>
        ) : (
          <a href={url!} target="_blank" rel="noopener noreferrer" title={`Open ${name}`} className={frame}>{thumb}</a>
        )
      ) : error ? (
        <Status error>{`image ${error} — ${name}`}</Status>
      ) : (
        <Status>loading image…</Status>
      )}
      <figcaption className="flex items-center gap-1.5 text-[11px] text-on-surface-variant">
        <span className="truncate max-w-[12rem]" title={media.path}>{name}</span>
        {url && <DownloadLink url={url} name={name} />}
      </figcaption>
    </figure>
  );
}

function TurnAudio({ media, sessionId }: { media: TurnMedia; sessionId: string }) {
  const { url, error } = useSessionMediaUrl(sessionId, media.path, media.kind);
  const name = mediaFileName(media);
  const label = media.deliver === 'voice' ? 'Spoken reply' : name;
  return (
    <div className="flex flex-col gap-1" data-testid="turn-media-audio" data-path={media.path}>
      {url ? (
        <audio controls preload="metadata" src={url} aria-label={label} className="h-9 w-72 max-w-full" />
      ) : error ? (
        <Status error>{`audio ${error} — ${name}`}</Status>
      ) : (
        <Status>loading audio…</Status>
      )}
      <div className="flex items-center gap-1.5 text-[11px] text-on-surface-variant">
        <Volume2 className="h-3 w-3 shrink-0 opacity-60" aria-hidden="true" />
        <span className="truncate max-w-[12rem]" title={media.path}>{label}</span>
        {url && <DownloadLink url={url} name={name} />}
      </div>
    </div>
  );
}

export function TurnMediaList({ media, sessionId, onOpenFile }: { media: TurnMedia[]; sessionId: string; onOpenFile?: (path: string) => void }) {
  return (
    <div className="flex flex-wrap items-start gap-3 px-1" data-testid="turn-media">
      {media.map((item) => item.kind === 'image'
        ? <TurnImage key={item.path} media={item} sessionId={sessionId} onOpenFile={onOpenFile} />
        : <TurnAudio key={item.path} media={item} sessionId={sessionId} />)}
    </div>
  );
}
