import { HeadContent, Scripts, createRootRoute, redirect, useRouterState, Link } from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'
import { LayoutDashboard, KanbanSquare, CalendarRange, BarChart3, Sparkles, UserCog, Compass } from 'lucide-react'
import { AuthControl } from '@/components/AuthControl'
import ThemeToggle from '@/components/ThemeToggle'
import { Button } from '@/components/ui/button'
import { getSessionState } from '@/server/session'

import appCss from '../styles.css?url'

const THEME_INIT_SCRIPT = `(function(){try{var stored=window.localStorage.getItem('theme');var mode=(stored==='light'||stored==='dark'||stored==='auto')?stored:'auto';var prefersDark=window.matchMedia('(prefers-color-scheme: dark)').matches;var resolved=mode==='auto'?(prefersDark?'dark':'light'):mode;var root=document.documentElement;root.classList.remove('light','dark');root.classList.add(resolved);if(mode==='auto'){root.removeAttribute('data-theme')}else{root.setAttribute('data-theme',mode)}root.style.colorScheme=resolved;}catch(e){}})();`

export const Route = createRootRoute({
  // Gate the whole app: unauthenticated users are redirected to /login.
  // The result is stashed in context so /login and the shell can read it
  // without re-fetching. When auth isn't configured (no Google/secret env in
  // dev) there's no way to sign in, so we don't gate — the dev escape hatch.
  beforeLoad: async ({ location }) => {
    const auth = await getSessionState()
    const isAuthRoute =
      location.pathname === '/login' || location.pathname.startsWith('/api/')
    if (auth.configured && !auth.authenticated && !isAuthRoute) {
      throw redirect({ to: '/login' })
    }
    return { auth }
  },
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
      },
      {
        title: 'Life Assistant — Your AI Coach',
      },
    ],
    links: [
      {
        rel: 'stylesheet',
        href: appCss,
      },
    ],
  }),
  shellComponent: RootDocument,
  notFoundComponent: NotFound,
})

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
  )
}

function RootDocument({ children }: { children: React.ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const showNav = pathname !== '/login'
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <HeadContent />
      </head>
      <body className="font-sans antialiased min-h-screen bg-background text-foreground">
        {/* Persistent nav (hidden on the login gate) */}
        {showNav && (
        <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur px-4 py-2 text-sm sm:px-6">
          <div className="mx-auto flex w-full max-w-page items-center justify-between gap-3">
            <Link to="/" className="flex items-center gap-1.5 font-semibold tracking-tight">
              <Sparkles className="size-4 text-primary" />
              Life&nbsp;Assistant
            </Link>
            <div className="flex items-center gap-2">
              <nav className="flex items-center gap-1 font-medium">
                {[
                  { to: '/', label: 'Dashboard', Icon: LayoutDashboard },
                  { to: '/kanban', label: 'Kanban', Icon: KanbanSquare },
                  { to: '/weekly', label: 'Weekly', Icon: CalendarRange },
                  { to: '/analytics', label: 'Analytics', Icon: BarChart3 },
                  { to: '/profile', label: 'Profile', Icon: UserCog },
                ].map(({ to, label, Icon }) => (
                  <Link
                    key={to}
                    to={to}
                    activeOptions={{ exact: to === '/' }}
                    className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    activeProps={{ className: 'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 bg-muted text-foreground' }}
                  >
                    <Icon className="size-4" />
                    <span className="hidden sm:inline">{label}</span>
                  </Link>
                ))}
              </nav>
              <div className="ml-1 flex items-center gap-2 border-l pl-2">
                <ThemeToggle />
                <AuthControl />
              </div>
            </div>
          </div>
        </header>
        )}
        {children}
        <TanStackDevtools
          config={{
            position: 'bottom-right',
          }}
          plugins={[
            {
              name: 'Tanstack Router',
              render: <TanStackRouterDevtoolsPanel />,
            },
          ]}
        />
        <Scripts />
      </body>
    </html>
  )
}
