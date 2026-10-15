'use client';

/**
 * The host frame of one interactive answer (spec D6). The document is built
 * once per mount from constants and a JSON payload; the page listens to this
 * frame only, validates every message (S5), and unmounts it on a flood.
 */
import { useEffect, useRef, useState } from 'react';
import {
  buildHostDocument,
  INLINE_UI_FRAME_SANDBOX,
  type InlineUiHostMessage,
  INLINE_UI_LIMITS,
  parseInlineUiHostMessage,
} from '../../../../src/shared/inline-ui';

export interface InlineUiFrameProps {
  title: string;
  html: string;
  css: string;
  js: string;
  mode: 'static' | 'scripted';
  /** A streaming preview: static, fed by `update`. */
  preview?: boolean;
  /** Latest preview content; posted to the host when it changes. */
  update?: { html: string; css: string };
  height: number;
  onMessage: (message: InlineUiHostMessage) => void;
  /** The frame sent garbage faster than S9 allows. */
  onFlood: () => void;
  /** The host frame element, for the focus guard (S14). */
  frameRef?: (el: HTMLIFrameElement | null) => void;
}

function randomChannel(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function InlineUiFrame({ title, html, css, js, mode, preview, update, height, onMessage, onFlood, frameRef }: InlineUiFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // Built once per mount: a new document is a new mount (Restart remounts).
  const [frame] = useState(() => {
    const channel = randomChannel();
    return { channel, doc: buildHostDocument({ channel, title, html, css, js, mode, preview, theme: 'dark' }).doc };
  });
  const onMessageRef = useRef(onMessage);
  const onFloodRef = useRef(onFlood);
  useEffect(() => { onMessageRef.current = onMessage; onFloodRef.current = onFlood; });

  useEffect(() => {
    const invalid: number[] = [];
    const listener = (event: MessageEvent) => {
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
      const message = parseInlineUiHostMessage(event.data, frame.channel);
      if (message) { onMessageRef.current(message); return; }
      const now = Date.now();
      invalid.push(now);
      while (invalid.length && now - invalid[0] > 1000) invalid.shift();
      if (invalid.length > INLINE_UI_LIMITS.floodPerSecond) onFloodRef.current();
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, [frame.channel]);

  useEffect(() => {
    if (!preview || !update) return;
    // The host frame is a sandboxed srcdoc document: its origin is opaque, so no
    // origin can be named; the message goes to that one window only.
    // nosemgrep: javascript.browser.security.wildcard-postmessage-configuration.wildcard-postmessage-configuration -- target is our own sandboxed (opaque-origin) host frame's contentWindow
    iframeRef.current?.contentWindow?.postMessage({ v: 1, ch: frame.channel, type: 'update', html: update.html, css: update.css }, '*');
  }, [preview, update, frame.channel]);

  return (
    <iframe
      ref={(el) => { iframeRef.current = el; frameRef?.(el); }}
      title={title}
      sandbox={INLINE_UI_FRAME_SANDBOX}
      referrerPolicy="no-referrer"
      srcDoc={frame.doc}
      data-testid="inline-ui-frame"
      style={{ width: '100%', height: `${height}px`, border: 0, display: 'block', background: 'transparent', colorScheme: 'normal' }}
    />
  );
}
