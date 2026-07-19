import { useState, useRef, useLayoutEffect } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  SquaresFourIcon,
  SparkleIcon,
  HeartbeatIcon,
  KanbanIcon,
  WalletIcon,
  CalendarDotsIcon,
  ChartBarIcon,
  UserGearIcon,
  InfoIcon,
  SignOutIcon,
  SignInIcon,
  CircleNotchIcon,
  DotsThreeIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import ThemeToggle from "@/components/theme-toggle";
import { signIn, signOut, useSession } from "@/lib/auth-client";
import {
  activePrimaryKey,
  BOTTOM_DESTINATIONS,
  DESKTOP_DESTINATIONS,
  MORE_ACTIVE_MATCH,
  MORE_GROUPS,
  type AppPath,
  type IconKey,
} from "@/lib/navigation";

const ICONS: Record<IconKey, PhosphorIcon> = {
  today: SquaresFourIcon,
  coach: SparkleIcon,
  health: HeartbeatIcon,
  tasks: KanbanIcon,
  money: WalletIcon,
  review: CalendarDotsIcon,
  trends: ChartBarIcon,
  profile: UserGearIcon,
  about: InfoIcon,
};

export function AppNav() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <>
      <header className="app-shelf sticky top-0 z-50">
        <div className="mx-auto flex h-full w-full items-center justify-between px-4 lg:px-8">
          {/* Left: Brand logo */}
          <div className="flex shrink-0">
            <Brand />
          </div>

          {/* Center: Desktop Nav */}
          <div className="hidden flex-1 justify-center lg:flex">
            <DesktopTabs pathname={pathname} />
          </div>

          {/* Right: Theme & Account Menu */}
          <div className="flex shrink-0 items-center gap-1 lg:gap-2">
            <MoreMenu pathname={pathname} />
            <ThemeToggle />
            <AccountMenu />
          </div>
        </div>
      </header>

      <BottomBar pathname={pathname} />
    </>
  );
}

// --- Brand: theme-aware explicit logo crossfade (no tagline) ---------------

function Brand() {
  return (
    <Link to="/" aria-label="Compass — home" className="flex shrink-0 items-center gap-2.5">
      <span className="logo-crossfade size-9 sm:size-10">
        <img
          src="/compass-light.svg"
          alt=""
          className="logo-light size-9 rounded-full border border-border/40 shadow-sm sm:size-10"
        />
        <img
          src="/compass-dark.svg"
          alt=""
          className="logo-dark size-9 rounded-full border border-border/40 shadow-sm sm:size-10"
        />
      </span>
      <span className="hidden text-[15px] font-semibold tracking-[0.18em] text-foreground lg:inline">
        COMPASS
      </span>
    </Link>
  );
}

// --- Desktop: quiet tabs with a sliding crimson bottom-border underline ------
// The active item is marked by a short crimson underline. A single absolutely
// positioned bar is driven by the measured left/width of the active tab, so it
// only ever slides HORIZONTALLY (a CSS transform transition) — it can never
// drift vertically the way a viewport-measured layout animation can.

function DesktopTabs({ pathname }: { pathname: string }) {
  const active = activePrimaryKey(DESKTOP_DESTINATIONS, pathname);
  const navRef = useRef<HTMLElement>(null);
  const [marker, setMarker] = useState<{ left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const measure = () => {
      const el = nav.querySelector<HTMLElement>(`[data-tab="${active}"]`);
      if (!el) {
        setMarker(null);
        return;
      }
      // Underline spans the middle 60% of the tab.
      const inset = el.offsetWidth * 0.2;
      setMarker({ left: el.offsetLeft + inset, width: el.offsetWidth - inset * 2 });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(nav);
    return () => ro.disconnect();
  }, [active]);

  const tabClass = (on: boolean) =>
    `relative flex min-h-10 items-center gap-2.5 px-3 pb-2.5 pt-2 text-[15px] font-medium transition-colors duration-200 ${
      on ? "text-foreground" : "text-muted-foreground hover:text-foreground"
    }`;

  return (
    <nav ref={navRef} aria-label="Primary" className="relative flex items-center gap-1">
      {DESKTOP_DESTINATIONS.map((tab) => {
        const on = active === tab.key;
        return (
          <Link
            key={tab.key}
            to={tab.to}
            data-tab={tab.key}
            aria-current={on ? "page" : undefined}
            className={tabClass(on)}
          >
            {tab.label}
          </Link>
        );
      })}
      {marker && (
        <span
          aria-hidden
          className="pointer-events-none absolute bottom-0 left-0 h-[2px] rounded-t-sm bg-primary transition-[transform,width] duration-300 ease-out"
          style={{ width: marker.width, transform: `translateX(${marker.left}px)` }}
        />
      )}
    </nav>
  );
}

// --- Below lg: fixed bottom tab bar with elevated center Coach -------------

function BottomBar({ pathname }: { pathname: string }) {
  const active = activePrimaryKey(BOTTOM_DESTINATIONS, pathname);

  return (
    <nav aria-label="Primary" className="app-tabbar fixed inset-x-0 bottom-0 z-50 lg:hidden">
      <div className="mx-auto flex max-w-page items-end justify-around px-2 pt-1">
        {BOTTOM_DESTINATIONS.map((tab) => {
          const on = active === tab.key;
          const Icon = ICONS[tab.icon];
          if (tab.key === "coach") {
            return (
              <Link
                key={tab.key}
                to={tab.to}
                aria-label={tab.label}
                aria-current={on ? "page" : undefined}
                className="flex flex-1 flex-col items-center gap-1 pb-1.5"
              >
                <span className="nav-coach-halo -mt-6 rounded-full p-1">
                  <span
                    data-active={on}
                    className="nav-coach flex size-14 items-center justify-center rounded-full"
                  >
                    <Icon className="size-6" weight="duotone" />
                  </span>
                </span>
                <span
                  className={`text-[10px] font-medium ${on ? "text-primary" : "text-muted-foreground"}`}
                >
                  {tab.label}
                </span>
              </Link>
            );
          }
          return (
            <Link
              key={tab.key}
              to={tab.to}
              aria-current={on ? "page" : undefined}
              className={`flex min-h-10 flex-1 flex-col items-center gap-1 rounded-lg py-1.5 text-[10px] font-medium transition-colors ${
                on ? "text-primary" : "text-muted-foreground"
              }`}
            >
              <span
                className={`flex size-8 items-center justify-center rounded-lg transition-colors ${on ? "bg-primary/10" : ""}`}
              >
                <Icon className="size-5" weight="duotone" />
              </span>
              {tab.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

// --- "More" overflow: bottom Sheet on phones, Popover on tablet ------------
// Both are always rendered; responsive display toggles which one is live so the
// behavior matches device class without measuring the viewport in JS.

function MoreMenu({ pathname }: { pathname: string }) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [popOpen, setPopOpen] = useState(false);

  // The More trigger carries the active marker while a Review destination
  // (/weekly or /analytics) is open, so overflow state stays legible.
  const moreActive = MORE_ACTIVE_MATCH.some((m) => pathname.startsWith(m));
  // Accessible name reflects the active overflow state so screen readers hear
  // "More, Review selected" — state is not conveyed by the marker color alone.
  const triggerLabel = moreActive ? "More, Review selected" : "More";
  const triggerClass = `relative flex min-h-10 min-w-10 items-center justify-center rounded-full transition-colors duration-200 hover:bg-muted hover:text-foreground lg:hidden ${
    moreActive ? "bg-primary/10 text-primary" : "text-muted-foreground"
  }`;

  return (
    <>
      {/* Phones: bottom sheet */}
      <div className="md:hidden">
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetTrigger
            aria-label={triggerLabel}
            aria-current={moreActive ? "page" : undefined}
            data-active={moreActive}
            className={triggerClass}
          >
            <DotsThreeIcon className="size-5" weight="duotone" />
          </SheetTrigger>
          <SheetContent
            side="bottom"
            className="rounded-t-2xl pb-[max(1rem,env(safe-area-inset-bottom))]"
          >
            <SheetHeader>
              <SheetTitle>More</SheetTitle>
            </SheetHeader>
            <div className="space-y-4 px-4 pb-4">
              {MORE_GROUPS.map((group) => (
                <div key={group.heading}>
                  <div className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    {group.heading}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {group.links.map(({ to, label, icon }) => (
                      <MoreTile
                        key={to}
                        to={to}
                        Icon={ICONS[icon]}
                        label={label}
                        pathname={pathname}
                        onSelect={() => setSheetOpen(false)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </SheetContent>
        </Sheet>
      </div>

      {/* Tablets (md → lg): popover */}
      <div className="hidden md:block lg:hidden">
        <Popover open={popOpen} onOpenChange={setPopOpen}>
          <PopoverTrigger
            aria-label={triggerLabel}
            aria-current={moreActive ? "page" : undefined}
            data-active={moreActive}
            className={triggerClass}
          >
            <DotsThreeIcon className="size-5" weight="duotone" />
          </PopoverTrigger>
          <PopoverContent align="end" className="w-52 p-1">
            {MORE_GROUPS.map((group, gi) => (
              <div key={group.heading} className={gi > 0 ? "mt-1 border-t pt-1" : undefined}>
                <div className="px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  {group.heading}
                </div>
                {group.links.map(({ to, label, icon }) => (
                  <MenuLink
                    key={to}
                    to={to}
                    Icon={ICONS[icon]}
                    label={label}
                    onSelect={() => setPopOpen(false)}
                  />
                ))}
              </div>
            ))}
          </PopoverContent>
        </Popover>
      </div>
    </>
  );
}

function MoreTile({
  to,
  Icon,
  label,
  pathname,
  onSelect,
}: {
  to: AppPath;
  Icon: PhosphorIcon;
  label: string;
  pathname: string;
  onSelect: () => void;
}) {
  const on = pathname.startsWith(to);
  return (
    <Link
      to={to}
      onClick={onSelect}
      aria-current={on ? "page" : undefined}
      className={`relative flex min-h-10 items-center gap-3 rounded-xl border px-3 py-3 text-sm font-medium transition-colors ${
        on
          ? "border-primary/40 bg-primary/10 text-primary"
          : "border-border bg-card text-foreground hover:bg-muted"
      }`}
    >
      <span
        className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${on ? "bg-primary/10" : "bg-muted"}`}
      >
        <Icon className="size-5 text-primary" weight="duotone" />
      </span>
      {label}
    </Link>
  );
}

// --- Account (avatar) menu ------------------------------------------------

function AccountMenu() {
  const { data: session, isPending } = useSession();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  if (isPending) {
    return (
      <span className="flex size-10 items-center justify-center">
        <CircleNotchIcon className="size-4 animate-spin text-muted-foreground" weight="regular" />
      </span>
    );
  }

  if (!session?.user) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="h-8 gap-1.5"
        onClick={() => {
          signIn.social({ provider: "google", callbackURL: "/" }).catch(() => {});
        }}
      >
        <SignInIcon className="size-3.5" weight="duotone" /> Sign in
      </Button>
    );
  }

  const u = session.user;
  const initial = (u.name || u.email || "?").slice(0, 1).toUpperCase();

  async function handleSignOut() {
    setBusy(true);
    try {
      await signOut();
    } finally {
      window.location.assign("/login");
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Account menu"
          className="flex min-h-10 min-w-10 items-center justify-center rounded-full ring-2 ring-border/50 ring-offset-2 ring-offset-[var(--surface-raised)] transition-[box-shadow] hover:ring-primary/50 active:scale-[0.96]"
        >
          {u.image ? (
            <img
              src={u.image}
              alt=""
              className="size-9 rounded-full object-cover"
              referrerPolicy="no-referrer"
            />
          ) : (
            <span className="flex size-9 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary">
              {initial}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-1">
        <div className="border-b px-2.5 py-2">
          <div className="truncate text-sm font-medium">{u.name || "Signed in"}</div>
          {u.email && <div className="truncate text-xs text-muted-foreground">{u.email}</div>}
        </div>
        <div className="py-1">
          <MenuLink
            to="/profile"
            Icon={UserGearIcon}
            label="Profile"
            onSelect={() => setOpen(false)}
          />
          <MenuLink to="/about" Icon={InfoIcon} label="About" onSelect={() => setOpen(false)} />
        </div>
        <div className="border-t pt-1">
          <button
            type="button"
            onClick={handleSignOut}
            disabled={busy}
            className="flex min-h-10 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {busy ? (
              <CircleNotchIcon className="size-4 animate-spin" weight="regular" />
            ) : (
              <SignOutIcon className="size-4" weight="duotone" />
            )}{" "}
            Sign out
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function MenuLink({
  to,
  Icon,
  label,
  onSelect,
}: {
  to: AppPath;
  Icon: PhosphorIcon;
  label: string;
  onSelect: () => void;
}) {
  const base =
    "relative flex min-h-10 items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition-colors";
  return (
    <Link
      to={to}
      onClick={onSelect}
      className={`${base} text-muted-foreground hover:bg-muted hover:text-foreground`}
      activeProps={{
        className: `${base} bg-muted font-medium text-foreground`,
        "aria-current": "page",
      }}
    >
      <Icon className="size-4 text-primary" weight="duotone" /> {label}
    </Link>
  );
}
