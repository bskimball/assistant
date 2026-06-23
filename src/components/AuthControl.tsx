import { useState } from 'react'
import { LogIn, LogOut, Loader2 } from 'lucide-react'
import { signIn, signOut, useSession } from '@/lib/auth-client'
import { Button } from '@/components/ui/button'

/**
 * Compact sign-in / sign-out control (ADR-010).
 *
 * - Signed out: "Sign in" → Google OAuth via Better Auth.
 * - Signed in: shows the user's name/avatar + sign out.
 * - Degrades gracefully: if Google OAuth isn't configured the sign-in attempt
 *   surfaces a short hint instead of crashing the app.
 */
export function AuthControl() {
  const { data: session, isPending } = useSession()
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState<string | null>(null)

  async function handleSignIn() {
    setBusy(true)
    setHint(null)
    try {
      await signIn.social({ provider: 'google', callbackURL: '/' })
    } catch {
      setHint('Sign-in unavailable — configure Google OAuth (see ADR-010).')
    } finally {
      setBusy(false)
    }
  }

  async function handleSignOut() {
    setBusy(true)
    try {
      await signOut()
    } finally {
      // Hard-redirect so the root auth guard re-runs and the now-signed-out
      // user can't keep viewing the page they were on.
      window.location.assign('/login')
    }
  }

  if (isPending) {
    return <Loader2 className="size-4 animate-spin text-muted-foreground" />
  }

  if (session?.user) {
    const u = session.user
    return (
      <div className="flex items-center gap-2">
        {u.image ? (
          <img src={u.image} alt="" className="size-6 rounded-full" referrerPolicy="no-referrer" />
        ) : (
          <span className="flex size-6 items-center justify-center rounded-full bg-muted text-[10px] font-medium">
            {(u.name || u.email || '?').slice(0, 1).toUpperCase()}
          </span>
        )}
        <span className="hidden text-xs text-muted-foreground sm:inline">{u.name || u.email}</span>
        <Button variant="ghost" size="icon" className="size-7" onClick={handleSignOut} disabled={busy} aria-label="Sign out" title="Sign out">
          <LogOut className="size-4" />
        </Button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2">
      {hint && <span className="hidden max-w-[200px] text-[10px] text-muted-foreground md:inline">{hint}</span>}
      <Button variant="outline" size="sm" className="h-7 gap-1.5" onClick={handleSignIn} disabled={busy}>
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <LogIn className="size-3.5" />}
        Sign in
      </Button>
    </div>
  )
}
