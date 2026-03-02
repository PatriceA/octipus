/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: {
    // NEXT_PUBLIC_API_URL: full override (e.g. "http://192.168.1.100:3005/api")
    // NEXT_PUBLIC_API_PORT: just the port (default: 3005) — hostname auto-detected from browser
  },
};

export default nextConfig;
