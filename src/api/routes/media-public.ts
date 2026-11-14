import { Elysia } from '@/api/http';
import { publicMedia } from '@/core/media/public-links';

/**
 * `GET /api/media/public/:token` — the bytes of a short-lived public media
 * link (src/core/media/public-links.ts), for a channel that fetches a URL.
 * Unauthenticated by design: the token is the capability, and it expires.
 */
export const mediaPublicRoutes = new Elysia().get('/media/public/:token', ({ params, set }) => {
  const media = /^[A-Za-z0-9_-]{32}$/.test(params.token) ? publicMedia(params.token) : null;
  if (!media) {
    set.status = 404;
    return { error: 'Not found' };
  }
  return new Response(new Uint8Array(media.data), {
    headers: {
      'Content-Type': media.mimeType,
      'Content-Disposition': `inline; filename="${media.filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
      'Cache-Control': 'private, max-age=900',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});
