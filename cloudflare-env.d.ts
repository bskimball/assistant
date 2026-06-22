/**
 * Cloudflare environment bindings (TanStack Start + @cloudflare/vite-plugin).
 *
 * - Run `npm run cf-typegen` after changing wrangler.jsonc to (re)generate worker-configuration.d.ts
 * - This file ensures `import { env } from 'cloudflare:workers'` works in TypeScript
 *   even before/without the generated file, and augments when present.
 */

/// <reference types="./worker-configuration.d.ts" />

declare module 'cloudflare:workers' {
  // CloudflareEnv is declared by wrangler types or our fallback
  export const env: CloudflareEnv
}

// Fallback in case worker-configuration.d.ts has not been generated yet.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-empty-interface
  interface CloudflareEnv {
    R2: R2Bucket
  }
}
