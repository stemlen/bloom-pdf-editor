import type { NextConfig } from 'next';

const isDev = process.env.NODE_ENV !== 'production';

// Fully static site (out/) served as Cloudflare Workers static assets — everything, including
// document conversion, runs in the browser.
const nextConfig: NextConfig = {
  output: 'export',
  images: { unoptimized: true },
  // Developer-only routes (e.g. /debug, the PDF parse debugger) live in `*.dev.tsx` files and are
  // left out of production builds, so they return 404 on the deployed site.
  pageExtensions: isDev ? ['dev.tsx', 'tsx', 'ts'] : ['tsx', 'ts'],
};

export default nextConfig;
