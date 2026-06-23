import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { Sparkles, LogIn, Loader2 } from "lucide-react";
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

  return (
    <div className="flex min-h-[80dvh] items-center justify-center px-4 py-12 sm:px-6">
      <div className="mx-auto w-full max-w-sm text-center">
        <div className="mx-auto mb-5 flex size-14 items-center justify-center rounded-2xl border bg-card">
          <Sparkles className="size-7 text-primary" />
        </div>
        <h1 className="text-2xl font-semibold tracking-tighter sm:text-3xl">Life Assistant</h1>
        <p className="mx-auto mt-2 max-w-xs text-sm text-muted-foreground">
          Sign in to access your daily dashboard, coach, and logs.
        </p>
        <div className="mt-6">
          <Button onClick={handleSignIn} disabled={busy} className="gap-2">
            {busy ? <Loader2 className="size-4 animate-spin" /> : <LogIn className="size-4" />}
            Sign in with Google
          </Button>
        </div>
        {hint && <div className="mt-3 text-xs text-muted-foreground">{hint}</div>}
      </div>
    </div>
  );
}
