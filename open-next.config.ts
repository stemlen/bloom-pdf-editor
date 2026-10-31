import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Every route is prerendered at build time and the app uses no ISR, on-demand revalidation or
// server-side data cache, so no R2/KV/D1 incremental-cache bindings are needed.
export default defineCloudflareConfig();
