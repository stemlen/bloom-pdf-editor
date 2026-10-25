import type { NextConfig } from 'next';

// Fully static site (out/) served as Cloudflare Workers static assets — everything, including
// document conversion, runs in the browser.
const nextConfig: NextConfig = {
  output: 'export',
  images: { unoptimized: true },
};

export default nextConfig;
