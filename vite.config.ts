import { defineConfig } from "vite-plus";
import { devtools } from "@tanstack/devtools-vite";
import { cloudflare } from "@cloudflare/vite-plugin";

import { tanstackStart } from "@tanstack/react-start/plugin/vite";

import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ mode }) => {
  const isVitest = mode === "test" || process.env.VITEST === "true";

  const __config = {
    resolve: { tsconfigPaths: true },
    plugins: [
      devtools(),
      tailwindcss(),
      // Cloudflare plugin enables Workers environment + bindings (incl. R2) during dev and build
      // Must precede tanstackStart for SSR env wiring. See ADR-001.
      // Vitest injects SSR externalization for Node built-ins; the Cloudflare plugin rejects that
      // before tests can start, including from VS Code Vitest Explorer.
      !isVitest && cloudflare({ viteEnvironment: { name: "ssr" } }),
      tanstackStart(),
      viteReact(),
    ].filter(Boolean),
    // cloudflare:workers (and similar) are virtual modules provided by the CF vite plugin
    // at dev/runtime in the ssr env. Externalize during build to prevent rolldown resolve
    // failures on the specifier (the module is injected by the worker runtime / plugin).
    build: {
      rolldownOptions: {
        external: ["cloudflare:workers"],
      },
    },
    // Vite+ unified config (check / lint+fmt+types, test, tasks)
    check: {
      // Oxlint + Oxfmt + type checking via vp check (respects .gitignore / explicit ignore)
    },
    test: {
      // Vitest config picked up by vp test (shares Vite resolve/transform)
      environment: "jsdom",
      globals: true,
    },
  };

  return __config as any;
});
