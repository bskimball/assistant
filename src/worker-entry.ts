import startEntry from "@tanstack/react-start/server-entry";

type FetchHandler = (
  request: Request,
  env: unknown,
  ctx: ExecutionContext,
) => Response | Promise<Response>;

const startFetch = (
  typeof startEntry === "function" ? startEntry : (startEntry as { fetch?: unknown }).fetch
) as FetchHandler | undefined;

if (typeof startFetch !== "function") {
  throw new Error("TanStack Start server entry does not export a fetch handler.");
}

export default {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext) {
    return startFetch(request, env, ctx);
  },

  scheduled(_controller: ScheduledController, _env: unknown, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        try {
          const [{ runWithUserScope }, { runSimplefinSyncImpl }] = await Promise.all([
            import("@/server/request-context"),
            import("@/server/finance-sync"),
          ]);
          const result = await runWithUserScope("brian", () =>
            runSimplefinSyncImpl({ manual: false }),
          );
          console.log("[simplefin] scheduled sync", {
            ok: result.ok,
            message: result.message,
            transactionCount: result.transactionCount,
          });
        } catch (err) {
          console.warn("[simplefin] scheduled sync failed", err);
        }
      })(),
    );
  },
};
