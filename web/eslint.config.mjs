import nextConfig from 'eslint-config-next';

const config = [
  ...nextConfig,
  {
    ignores: ['.next/', 'node_modules/'],
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
