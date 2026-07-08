import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { LogIn, Loader2, Fingerprint } from "lucide-react";
import { signIn } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/login")({
  // Already signed in? Skip the gate. Root has already populated `auth`.
  beforeLoad: ({ context }: any) => {
    if (context?.auth?.authenticated) {
      throw redirect({ to: "/" });
    }
  },
  component: LoginPage,
});

function LoginPage() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  async function handleSignIn() {
    setBusy(true);
    setHint(null);
    try {
      await signIn.social({ provider: "google", callbackURL: "/" });
    } catch {
      setHint("Sign-in unavailable — configure Google OAuth (see ADR-010).");
      setBusy(false);
    }
  }

  async function handlePasskeySignIn() {
    setBusy(true);
    setHint(null);
    try {
      const res = await signIn.passkey();
      if (res?.error) {
        setHint("Fingerprint sign-in failed. Use Google, then enable it again.");
        setBusy(false);
        return;
      }
      // Success → re-run the root auth guard and land on the dashboard.
      await router.invalidate();
      window.location.assign("/");
    } catch {
      setHint("No passkey on this device yet. Sign in with Google to enable it.");
      setBusy(false);
    }
  }

  return (
    <div className="relative flex min-h-[80dvh] items-center justify-center px-4 py-12 sm:px-6">
      {/* Soft wash behind the card — first-impression warmth without noise. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-linear-to-b from-primary/6 to-transparent"
      />
      <div className="relative mx-auto w-full max-w-sm">
        <div className="rounded-2xl border-primary/20 bg-linear-to-br from-primary/8 via-card to-card p-6 text-center shadow-sm ring-1 ring-foreground/10 sm:p-8">
          <div className="mx-auto mb-5 flex size-14 items-center justify-center rounded-2xl bg-background/70 shadow-[0_1px_0_rgba(0,0,0,0.05)] ring-1 ring-foreground/10">
            <img src="/compass.svg" alt="" className="size-12 rounded-xl" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tighter sm:text-3xl">Compass</h1>
          <p className="mx-auto mt-2 max-w-xs text-pretty text-sm text-muted-foreground">
            Sign in to access your daily dashboard, coach, and logs.
          </p>
          <div className="mt-6 flex flex-col gap-2">
            <Button
              onClick={handleSignIn}
              disabled={busy}
              className="h-10 w-full gap-2 transition-[scale,background-color,color,box-shadow] duration-150 ease-out active:scale-[0.96]"
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : <LogIn className="size-4" />}
              Sign in with Google
            </Button>
            <Button
              variant="outline"
              onClick={handlePasskeySignIn}
              disabled={busy}
              className="h-10 w-full gap-2 transition-[scale,background-color,color,box-shadow] duration-150 ease-out active:scale-[0.96]"
            >
              <Fingerprint className="size-4" />
              Sign in with fingerprint
            </Button>
          </div>
          {hint && (
            <div
              role="status"
              className="mt-4 rounded-lg bg-background/70 px-3 py-2 text-pretty text-xs text-muted-foreground shadow-[0_1px_0_rgba(0,0,0,0.05)] ring-1 ring-foreground/10"
            >
              {hint}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
