import { useEffect } from "react";
import {
  HeadContent,
  Scripts,
  createRootRouteWithContext,
  redirect,
  useRouterState,
  Link,
} from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { TanStackDevtools } from "@tanstack/react-devtools";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { LayoutDashboard, Compass } from "lucide-react";
import { AppNav } from "@/components/AppNav";
import { Button } from "@/components/ui/button";
import { getSessionState } from "@/server/session";

import appCss from "../styles.css?url";

const THEME_INIT_SCRIPT = `(function(){try{var stored=window.localStorage.getItem('theme');var mode=(stored==='light'||stored==='dark'||stored==='auto')?stored:'auto';var prefersDark=window.matchMedia('(prefers-color-scheme: dark)').matches;var resolved=mode==='auto'?(prefersDark?'dark':'light'):mode;var root=document.documentElement;root.classList.remove('light','dark');root.classList.add(resolved);if(mode==='auto'){root.removeAttribute('data-theme')}else{root.setAttribute('data-theme',mode)}root.style.colorScheme=resolved;}catch(e){}})();`;

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  // Gate the whole app: unauthenticated users are redirected to /login.
  // The result is stashed in context so /login and the shell can read it
  // without re-fetching. When auth isn't configured (no Google/secret env in
  // dev) there's no way to sign in, so we don't gate — the dev escape hatch.
  beforeLoad: async ({ location }) => {
    const auth = await getSessionState();
    const isAuthRoute = location.pathname === "/login" || location.pathname.startsWith("/api/");
    if (auth.configured && !auth.authenticated && !isAuthRoute) {
      throw redirect({ to: "/login" });
    }
    return { auth };
  },
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=5",
      },
      {
        title: "Compass — Your AI Coach",
      },
      {
        name: "description",
        content: "A personal AI life coach for fitness, nutrition, finance, and productivity.",
      },
      // PWA / installability
      { name: "application-name", content: "Compass" },
      { name: "mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-title", content: "Compass" },
      { name: "apple-mobile-web-app-status-bar-style", content: "default" },
      // Adaptive toolbar color: blends with the app background in each scheme.
      { name: "theme-color", content: "#f4f1ec", media: "(prefers-color-scheme: light)" },
      { name: "theme-color", content: "#13151d", media: "(prefers-color-scheme: dark)" },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
      { rel: "manifest", href: "/manifest.json" },
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "icon", href: "/favicon.ico", sizes: "48x48" },
      { rel: "icon", type: "image/png", sizes: "192x192", href: "/logo192.png" },
      { rel: "apple-touch-icon", sizes: "180x180", href: "/apple-touch-icon.png" },
    ],
  }),
  shellComponent: RootDocument,
  notFoundComponent: NotFound,
});

function NotFound() {
  return (
    <div className="flex min-h-[70dvh] items-center justify-center px-4 py-12 sm:px-6">
      <div className="mx-auto w-full max-w-md text-center">
        <div className="mx-auto mb-5 flex size-14 items-center justify-center rounded-2xl border bg-card">
          <Compass className="size-7 text-primary" />
        </div>
        <div className="text-xs uppercase tracking-[2px] text-muted-foreground">404</div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tighter sm:text-3xl">
          This page wandered off.
        </h1>
        <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
          The page you’re looking for doesn’t exist or may have moved. Let’s get you back on track.
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <Button asChild size="sm" className="gap-1.5">
            <Link to="/">
              <LayoutDashboard className="size-4" /> Back to dashboard
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link to="/about">Learn about the app</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}

function RootDocument({ children }: { children: React.ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const showNav = pathname !== "/login";

  // Register the service worker for installability + offline fallback. Only in
  // production builds — in dev the SW would cache HMR assets and fight Vite.
  useEffect(() => {
    if (!import.meta.env.PROD) return;
    if (!("serviceWorker" in navigator)) return;
    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // Registration is best-effort; the app works without it.
      });
    };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }, []);
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <HeadContent />
      </head>
      <body className="font-sans antialiased min-h-screen bg-background text-foreground">
        {/* Persistent nav (hidden on the login gate) */}
        {showNav && <AppNav />}
        {/* Page transitions (motion). Keyed on pathname so each navigation runs
            a subtle exit→enter; in-page search changes (same pathname) don't
            retrigger it. `mode="wait"` lets the old page leave before the new
            one arrives; `initial={false}` skips the animation on first paint so
            SSR content doesn't flash in. `MotionConfig reducedMotion="user"`
            honors the OS reduce-motion setting without changing the DOM (no
            hydration mismatch). */}
        <MotionConfig reducedMotion="user">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={pathname}
              initial={{ opacity: 0, y: 8, filter: "blur(4px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              exit={{
                opacity: 0,
                y: -8,
                filter: "blur(4px)",
                transition: { duration: 0.15, ease: "easeIn" },
              }}
              transition={{ type: "spring", duration: 0.3, bounce: 0 }}
            >
              {children}
            </motion.div>
          </AnimatePresence>
        </MotionConfig>
        <TanStackDevtools
          config={{
            position: "bottom-right",
          }}
          plugins={[
            {
              name: "Tanstack Router",
              render: <TanStackRouterDevtoolsPanel />,
            },
          ]}
        />
        <Scripts />
      </body>
    </html>
  );
}
