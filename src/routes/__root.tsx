import { useEffect, useState } from "react";
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
import { MotionConfig } from "motion/react";
import { LayoutDashboard, Compass } from "lucide-react";
import { AppNav } from "@/components/app-nav";
import { RouteError } from "@/components/route-error";
import { Button } from "@/components/ui/button";
import { shellShowsNav } from "@/lib/navigation";
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
      { name: "robots", content: "noindex,nofollow" },
      // PWA / installability
      { name: "application-name", content: "Compass" },
      { name: "mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-title", content: "Compass" },
      { name: "apple-mobile-web-app-status-bar-style", content: "default" },
      // Adaptive toolbar color: matches the opaque shelf (surface-raised) in
      // each scheme — warm mineral in light, deep lake ink in dark.
      { name: "theme-color", content: "#f7f2e9", media: "(prefers-color-scheme: light)" },
      { name: "theme-color", content: "#1d2734", media: "(prefers-color-scheme: dark)" },
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
  errorComponent: RouteError,
});

function NotFound() {
  return (
    <div className="flex min-h-[70dvh] items-center justify-center px-4 py-12 sm:px-6">
      <div className="mx-auto w-full max-w-md text-center">
        <div className="mx-auto mb-5 flex size-14 items-center justify-center rounded-2xl border bg-card">
          <Compass className="size-7 text-primary" />
        </div>
        <div className="text-xs tracking-tight text-muted-foreground">404</div>
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
  // True while a navigation's loaders are still running — the old page is
  // still on screen. Drives the top progress bar + content dimming so a slow
  // load never looks like a dead click.
  const isNavigating = useRouterState({ select: (s) => s.status === "pending" });
  const showNav = shellShowsNav(pathname);

  // The router can be "pending" during SSR/streaming, but on the client's
  // first render it is idle — rendering pending-only UI on the server causes
  // a hydration mismatch. Gate it until after hydration.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const showPending = hydrated && isNavigating;

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
        {showPending && <div className="route-progress" aria-hidden />}
        {/* No shell-level page fade. A whole-page opacity transition here caused
            a black "blink" between routes: with the photographic route
            backgrounds, fading the outgoing page to 0 revealed the dark body
            background before the incoming page mounted. Each route already
            animates its own content in via <Reveal>/<Stagger>, so entrance
            motion is handled per-page and the shell just swaps children.

            The only shell-level treatment is the pending-dim: while the next
            route's loaders run, the stale page dims slightly so a tap registers
            visually. The 150ms delay keeps fast (cached) navigations from
            flickering. MotionConfig reducedMotion="user" still honors the OS
            reduce-motion setting for the per-page content animations. */}
        <MotionConfig reducedMotion="user">
          <div
            className={`transition-opacity delay-150 duration-300 ${
              showPending ? "opacity-40" : "opacity-100"
            }`}
          >
            {children}
          </div>
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
