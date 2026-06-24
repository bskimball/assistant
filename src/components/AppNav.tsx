import { useEffect, useRef, useState } from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import {
  LayoutDashboard,
  HeartPulse,
  Dumbbell,
  Utensils,
  KanbanSquare,
  CalendarRange,
  BarChart3,
  Sparkles,
  ChevronDown,
  UserCog,
  Info,
  LogOut,
  LogIn,
  Loader2,
} from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import ThemeToggle from '@/components/ThemeToggle'
import { signIn, signOut, useSession } from '@/lib/auth-client'

type Leaf = { to: string; label: string; Icon: typeof LayoutDashboard }
type Tab =
  | { kind: 'link'; to: string; label: string; Icon: typeof LayoutDashboard }
  | { kind: 'group'; label: string; Icon: typeof LayoutDashboard; items: Leaf[] }

// Top-level destinations, left→right. Health groups the body domains (Workouts
// + Nutrition); Insights groups the review/analytics views. Grouping keeps the
// bar at four tabs even as those areas grow.
const TABS: Tab[] = [
  { kind: 'link', to: '/', label: 'Today', Icon: LayoutDashboard },
  {
    kind: 'group',
    label: 'Health',
    Icon: HeartPulse,
    items: [
      { to: '/workouts', label: 'Workouts', Icon: Dumbbell },
      { to: '/nutrition', label: 'Nutrition', Icon: Utensils },
    ],
  },
  { kind: 'link', to: '/kanban', label: 'Tasks', Icon: KanbanSquare },
  {
    kind: 'group',
    label: 'Insights',
    Icon: BarChart3,
    items: [
      { to: '/weekly', label: 'Weekly', Icon: CalendarRange },
      { to: '/analytics', label: 'Trends', Icon: BarChart3 },
    ],
  },
]

// Index of the active top-level tab (-1 = none), matching TABS order.
function activeIndexFor(pathname: string): number {
  return TABS.findIndex((t) =>
    t.kind === 'link'
      ? t.to === '/'
        ? pathname === '/'
        : pathname.startsWith(t.to)
      : t.items.some((it) => pathname.startsWith(it.to)),
  )
}

export function AppNav() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const activeIndex = activeIndexFor(pathname)

  return (
    <>
      <header className="sticky top-0 z-50 border-b bg-background/90 px-4 py-2 backdrop-blur sm:px-6">
        <div className="mx-auto flex w-full max-w-page items-center justify-between gap-3">
          <Link
            to="/"
            className="flex shrink-0 items-center gap-1.5 text-sm font-semibold tracking-tight"
          >
            <Sparkles className="size-4 text-primary" />
            Life&nbsp;Assistant
          </Link>

          <DesktopTabs activeIndex={activeIndex} />

          <div className="flex shrink-0 items-center gap-1.5">
            <ThemeToggle />
            <AccountMenu />
          </div>
        </div>
      </header>

      <BottomBar activeIndex={activeIndex} />
    </>
  )
}

// --- Desktop: pill tabs with a sliding active indicator -------------------

function DesktopTabs({ activeIndex }: { activeIndex: number }) {
  const navRef = useRef<HTMLDivElement>(null)
  const [openGroup, setOpenGroup] = useState<number | null>(null)
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null)

  // Measure the active tab and slide the indicator to it. Re-measures on
  // navigation and on resize. Hidden entirely when no tab is active.
  useEffect(() => {
    function measure() {
      const container = navRef.current
      if (!container) return
      const tabs = container.querySelectorAll<HTMLElement>('[data-tab]')
      const el = activeIndex >= 0 ? tabs[activeIndex] : null
      setIndicator(el ? { left: el.offsetLeft, width: el.offsetWidth } : null)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [activeIndex])

  const tabClass = (active: boolean) =>
    `relative z-10 flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors duration-200 ${
      active ? 'text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
    }`

  return (
    <div ref={navRef} className="relative hidden items-center gap-1 sm:flex">
      {indicator && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 z-0 rounded-lg bg-primary transition-[transform,width] duration-300 ease-out"
          style={{ transform: `translateX(${indicator.left}px)`, width: indicator.width }}
        />
      )}

      {TABS.map((tab, i) => {
        const active = activeIndex === i
        if (tab.kind === 'link') {
          return (
            <Link key={tab.label} to={tab.to} data-tab className={tabClass(active)}>
              <tab.Icon className="size-4" />
              {tab.label}
            </Link>
          )
        }
        const open = openGroup === i
        return (
          <Popover
            key={tab.label}
            open={open}
            onOpenChange={(o) => setOpenGroup(o ? i : null)}
          >
            <PopoverTrigger asChild>
              <button type="button" data-tab className={tabClass(active)}>
                <tab.Icon className="size-4" />
                {tab.label}
                <ChevronDown
                  className={`size-3.5 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
                />
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-44 p-1">
              {tab.items.map(({ to, label, Icon }) => (
                <MenuLink key={to} to={to} Icon={Icon} label={label} onSelect={() => setOpenGroup(null)} />
              ))}
            </PopoverContent>
          </Popover>
        )
      })}
    </div>
  )
}

// --- Mobile: fixed bottom tab bar -----------------------------------------

function BottomBar({ activeIndex }: { activeIndex: number }) {
  const [openGroup, setOpenGroup] = useState<number | null>(null)

  const itemClass = (active: boolean) =>
    `flex flex-1 flex-col items-center gap-0.5 rounded-lg py-1.5 text-[10px] font-medium transition-colors ${
      active ? 'text-primary' : 'text-muted-foreground'
    }`
  const iconWrap = (active: boolean) =>
    `flex size-8 items-center justify-center rounded-full transition-all duration-200 ${
      active ? '-translate-y-0.5 bg-primary/15' : ''
    }`

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-50 border-t bg-background/90 backdrop-blur sm:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="mx-auto flex max-w-page items-stretch justify-around px-2 py-1.5">
        {TABS.map((tab, i) => {
          const active = activeIndex === i
          if (tab.kind === 'link') {
            return (
              <Link key={tab.label} to={tab.to} className={itemClass(active)}>
                <span className={iconWrap(active)}>
                  <tab.Icon className="size-5" />
                </span>
                {tab.label}
              </Link>
            )
          }
          const open = openGroup === i
          return (
            <Popover
              key={tab.label}
              open={open}
              onOpenChange={(o) => setOpenGroup(o ? i : null)}
            >
              <PopoverTrigger asChild>
                <button type="button" className={itemClass(active)}>
                  <span className={iconWrap(active)}>
                    <tab.Icon className="size-5" />
                  </span>
                  {tab.label}
                </button>
              </PopoverTrigger>
              <PopoverContent side="top" align="center" className="mb-2 w-44 p-1">
                {tab.items.map(({ to, label, Icon }) => (
                  <MenuLink
                    key={to}
                    to={to}
                    Icon={Icon}
                    label={label}
                    onSelect={() => setOpenGroup(null)}
                  />
                ))}
              </PopoverContent>
            </Popover>
          )
        })}
      </div>
    </nav>
  )
}

// --- Account (avatar) menu ------------------------------------------------

function AccountMenu() {
  const { data: session, isPending } = useSession()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  if (isPending) {
    return <Loader2 className="size-4 animate-spin text-muted-foreground" />
  }

  if (!session?.user) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="h-8 gap-1.5"
        onClick={() => {
          signIn.social({ provider: 'google', callbackURL: '/' }).catch(() => {})
        }}
      >
        <LogIn className="size-3.5" /> Sign in
      </Button>
    )
  }

  const u = session.user
  const initial = (u.name || u.email || '?').slice(0, 1).toUpperCase()

  async function handleSignOut() {
    setBusy(true)
    try {
      await signOut()
    } finally {
      window.location.assign('/login')
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Account menu"
          className="flex items-center gap-1 rounded-full p-0.5 pr-1.5 transition-colors hover:bg-muted"
        >
          {u.image ? (
            <img
              src={u.image}
              alt=""
              className="size-7 rounded-full"
              referrerPolicy="no-referrer"
            />
          ) : (
            <span className="flex size-7 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
              {initial}
            </span>
          )}
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-1">
        <div className="border-b px-2.5 py-2">
          <div className="truncate text-sm font-medium">{u.name || 'Signed in'}</div>
          {u.email && <div className="truncate text-xs text-muted-foreground">{u.email}</div>}
        </div>
        <div className="py-1">
          <MenuLink to="/profile" Icon={UserCog} label="Profile" onSelect={() => setOpen(false)} />
          <MenuLink to="/about" Icon={Info} label="About" onSelect={() => setOpen(false)} />
        </div>
        <div className="border-t pt-1">
          <button
            type="button"
            onClick={handleSignOut}
            disabled={busy}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <LogOut className="size-4" />} Sign
            out
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function MenuLink({
  to,
  Icon,
  label,
  onSelect,
}: {
  to: string
  Icon: typeof UserCog
  label: string
  onSelect: () => void
}) {
  const base = 'flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition-colors'
  return (
    <Link
      to={to}
      onClick={onSelect}
      className={`${base} text-muted-foreground hover:bg-muted hover:text-foreground`}
      activeProps={{ className: `${base} bg-muted text-foreground` }}
    >
      <Icon className="size-4 text-primary" /> {label}
    </Link>
  )
}
