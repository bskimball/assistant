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
    <div className="flex min-h-[80dvh] items-center justify-center px-4 py-12 sm:px-6">
      <div className="mx-auto w-full max-w-sm text-center">
        <div className="mx-auto mb-5 flex size-14 items-center justify-center rounded-2xl border bg-card">
          <img src="/compass.svg" alt="" className="size-12 rounded-2xl" />
        </div>
        <h1 className="text-2xl font-semibold tracking-tighter sm:text-3xl">Compass</h1>
        <p className="mx-auto mt-2 max-w-xs text-sm text-muted-foreground">
          Sign in to access your daily dashboard, coach, and logs.
        </p>
        <div className="mt-6 flex flex-col items-center gap-2">
          <Button onClick={handleSignIn} disabled={busy} className="gap-2">
            {busy ? <Loader2 className="size-4 animate-spin" /> : <LogIn className="size-4" />}
            Sign in with Google
          </Button>
          <Button variant="outline" onClick={handlePasskeySignIn} disabled={busy} className="gap-2">
            <Fingerprint className="size-4" />
            Sign in with fingerprint
          </Button>
        </div>
        {hint && <div className="mt-3 text-xs text-muted-foreground">{hint}</div>}
      </div>
    </div>
  );
}
