import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The desktop client is a static bundle served from the app's own origin, with
 * no dev-server proxy in front of it — it talks to a backend URL the user
 * chooses. The web build proxies same-origin instead.
 */
/**
 * Desktop is selected by Vite's own `--mode desktop` rather than by an
 * environment variable: `TAURI_BUILD=true vite` is sh syntax, and on Windows
 * cmd.exe reads it as a command name — `octi desktop` died there with "Der
 * Befehl TAURI_BUILD ist entweder falsch geschrieben oder konnte nicht
 * gefunden werden". `TAURI_ENV_PLATFORM` is set by the Tauri CLI itself for
 * the before*Command it spawns, so a build driven by `tauri build` is
 * recognised without either. The old variable is still honoured for anyone
 * with it in their shell.
 */
const apiTarget = process.env.INTERNAL_API_URL || `http://localhost:${process.env.API_PORT || 3005}`;

export default defineConfig(({ mode }) => {
const isDesktop =
  mode === 'desktop' || !!process.env.TAURI_ENV_PLATFORM || process.env.TAURI_BUILD === 'true';

return {
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // The pages keep importing from `next/*`; these are the four things they
      // actually used, reimplemented over React Router in `compat/next`.
      'next/navigation': resolve(here, 'compat/next/navigation.tsx'),
      'next/link': resolve(here, 'compat/next/link.tsx'),
      'next/image': resolve(here, 'compat/next/image.tsx'),
      next: resolve(here, 'compat/next/index.ts'),
      '@': here,
    },
  },
  define: {
    // Was baked by the framework's `env` config. Kept as a build-time constant
    // rather than a runtime window check so the desktop gate resolves the same
    // way everywhere in the bundle.
    'process.env.NEXT_PUBLIC_DESKTOP_BUILD': JSON.stringify(isDesktop ? '1' : ''),
    'process.env.NEXT_PUBLIC_API_URL': JSON.stringify(process.env.NEXT_PUBLIC_API_URL ?? ''),
    'process.env.NEXT_PUBLIC_API_PORT': JSON.stringify(process.env.NEXT_PUBLIC_API_PORT ?? ''),
  },
  server: {
    port: Number(process.env.WEB_PORT || 3007),
    // Never watch the Rust side. `tauri dev` runs cargo and this dev server at
    // the same time, and target/ is full of files cargo holds open while it
    // links them — on Windows the watcher hits one mid-build and dies with
    // EBUSY, taking the whole launch with it ("The beforeDevCommand terminated
    // with a non-zero status code"). Nothing under src-tauri/ is part of the
    // frontend bundle anyway.
    watch: { ignored: ['**/src-tauri/**'] },
    // Same-origin proxying, so the session cookie is attached to API calls and
    // to the hosted artifact pages the dashboard embeds in iframes.
    proxy: isDesktop ? undefined : {
      '/api': { target: apiTarget, changeOrigin: false, ws: true },
      '/__artifacts__': { target: apiTarget, changeOrigin: false },
      '/a': { target: apiTarget, changeOrigin: false },
    },
  },
  build: {
    outDir: isDesktop ? 'out' : 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
};
});
