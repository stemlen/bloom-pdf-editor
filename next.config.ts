import type { NextConfig } from 'next';

const isDev = process.env.NODE_ENV !== 'production';

// Production deploys build with OpenNext (`opennextjs-cloudflare build`) and run as a Cloudflare
// Worker. BLOOM_STATIC_EXPORT=1 (`npm run build:static`) instead emits a plain static site in out/,
// which the Playwright suite serves locally. Document conversion runs in the browser either way.
const staticExport = process.env.BLOOM_STATIC_EXPORT === '1';

const nextConfig: NextConfig = {
  ...(staticExport ? { output: 'export' as const } : {}),
  images: { unoptimized: true },
  // Developer-only routes (e.g. /debug, the PDF parse debugger) live in `*.dev.tsx` files and are
  // left out of production builds, so they return 404 on the deployed site.
  pageExtensions: isDev ? ['dev.tsx', 'tsx', 'ts'] : ['tsx', 'ts'],
};

export default nextConfig;
