import { HeadContent, Scripts, createRootRoute, Link } from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'
import { LayoutDashboard, KanbanSquare, CalendarRange, BarChart3, Sparkles } from 'lucide-react'
import { AuthControl } from '@/components/AuthControl'

import appCss from '../styles.css?url'

const THEME_INIT_SCRIPT = `(function(){try{var stored=window.localStorage.getItem('theme');var mode=(stored==='light'||stored==='dark'||stored==='auto')?stored:'auto';var prefersDark=window.matchMedia('(prefers-color-scheme: dark)').matches;var resolved=mode==='auto'?(prefersDark?'dark':'light'):mode;var root=document.documentElement;root.classList.remove('light','dark');root.classList.add(resolved);if(mode==='auto'){root.removeAttribute('data-theme')}else{root.setAttribute('data-theme',mode)}root.style.colorScheme=resolved;}catch(e){}})();`

export const Route = createRootRoute({
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
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <HeadContent />
      </head>
      <body className="font-sans antialiased min-h-screen bg-background text-foreground">
        {/* Persistent nav */}
        <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur px-4 py-2 text-sm">
          <div className="mx-auto flex max-w-[900px] items-center justify-between gap-3">
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
              <div className="ml-1 border-l pl-2">
                <AuthControl />
              </div>
            </div>
          </div>
        </header>
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
