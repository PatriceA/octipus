import nextConfig from 'eslint-config-next';

const config = [
  ...nextConfig,
  {
    // `.next-desktop/` is the Tauri static-export build dir (gitignored, ~1 GB
    // of generated chunks). CI never has it, so CI's lint is green — but any
    // developer who has run a desktop build gets ~530 errors from bundled
    // output and none from their own code, which makes the local lint useless
    // right where it should be most useful.
    ignores: ['.next/', '.next-desktop/', 'out/', 'node_modules/'],
  },
  {
    rules: {
      // The dashboard ships as a static export (Tauri desktop) where next/image
      // is unoptimized anyway, and the remaining <img> uses are data:/blob: URLs
      // (QR codes, upload previews, a tiny static logo) that next/image can't
      // meaningfully optimize. Plain <img> is the right tool here.
      '@next/next/no-img-element': 'off',
    },
  },
];

export default config;
