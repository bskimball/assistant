import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  // One client per request on the server, one for the browser session. Domain
  // data is per-user/per-day and changes rarely within a session, so a modest
  // staleTime makes revisiting a page instant (served from cache) while a
  // background refetch keeps it fresh. gcTime keeps it around across navigation.
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        // These reads are user-private and rarely change out from under us;
        // avoid surprise refetches that would re-trigger the load animations.
        refetchOnWindowFocus: false,
      },
    },
  });

  const router = createTanStackRouter({
    routeTree,
    // Exposed to every route's loader/beforeLoad as `context.queryClient`.
    context: { queryClient },
    scrollRestoration: true,
    defaultPreload: "intent",
    // Let TanStack Query own freshness: the router always calls loaders, and
    // `ensureQueryData` returns cached data when fresh (cheap), refetches when stale.
    defaultPreloadStaleTime: 0,
  });

  // Dehydrates the query cache on the server and rehydrates it on the client,
  // and wraps the app in <QueryClientProvider> — so loaders that prime the
  // cache during SSR hand off seamlessly to client `useQuery` with no refetch.
  setupRouterSsrQueryIntegration({ router, queryClient });

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
