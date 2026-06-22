import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const isTauri = process.env.TAURI_BUILD === 'true';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: isTauri ? 'export' : undefined,
  // Repo root, not web/ — components/pipeline-graph.tsx re-exports from
  // ../../src/core/orchestrator/pipeline-validation, so file tracing has to
  // include the parent directory.
  turbopack: {
    root: resolve(__dirname, '..'),
  },
  env: {
    // NEXT_PUBLIC_API_URL: full override (e.g. "http://192.168.1.100:3005/api")
    // NEXT_PUBLIC_API_PORT: just the port (default: 3005) — hostname auto-detected from browser
    //
    // Baked at build time so the desktop-connection gate decision is identical
    // on the prerender and the client (a runtime `isDesktop()` window check
    // would differ between the two and trip a hydration mismatch).
    NEXT_PUBLIC_DESKTOP_BUILD: isTauri ? '1' : '',
  },
  ...(isTauri ? {} : {
    async rewrites() {
      const apiTarget = process.env.INTERNAL_API_URL || `http://localhost:${process.env.API_PORT || 3005}`;
      return [
        {
          source: '/api/:path*',
          destination: `${apiTarget}/api/:path*`,
        },
        // Hosted artifact pages live on the API server (`/a/:slug` and the
        // DNS-less fallback `/__artifacts__/a/:slug`). Proxy both same-origin
        // so iframes embedded in the dashboard load with the user's session
        // cookie attached — `workspace`/`private` visibilities require auth.
        {
          source: '/__artifacts__/:path*',
          destination: `${apiTarget}/__artifacts__/:path*`,
        },
        {
          source: '/a/:path*',
          destination: `${apiTarget}/a/:path*`,
        },
      ];
    },
  }),
};

export default nextConfig;
