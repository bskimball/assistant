// The single navigation model. AppNav (global shelf/tab bar) and WorkspaceNav
// (local workspace pills) are render adapters over these tables — no component
// keeps its own copy of paths, labels, or match prefixes.
//
// ADR-025: desktop lg+ shows six destinations in a fixed order (Today, Coach,
// Health, Tasks, Money, Review); below lg five primary bottom tabs (Today,
// Health, Coach centered, Tasks, Money) plus a "More" overflow for Review and
// Account. Health and Review are workspaces with their own local nav.
//
// Icons live in the UI adapters (keyed by `icon` below) so this module stays
// framework/asset free.

// Every reachable destination path. `to` values across the app narrow to this
// union, so a typo becomes a type error rather than a dead link.
export type AppPath =
  | "/"
  | "/chat"
  | "/health"
  | "/health/workouts"
  | "/health/nutrition"
  | "/kanban"
  | "/finance"
  | "/finance/transactions"
  | "/finance/budget"
  | "/finance/recurring"
  | "/finance/investments"
  | "/finance/grow"
  | "/weekly"
  | "/analytics"
  | "/profile"
  | "/about";

export type Workspace = "health" | "money" | "review";

// Stable icon keys resolved to lucide components inside the adapters.
export type IconKey =
  | "today"
  | "coach"
  | "health"
  | "tasks"
  | "money"
  | "review"
  | "trends"
  | "profile"
  | "about";

export type Destination = {
  key: string;
  to: AppPath;
  label: string;
  icon: IconKey;
  // Path prefixes that light this destination. "/" matches exactly; every other
  // prefix matches itself and its descendants so nested routes stay active.
  match: string[];
};

// Desktop top-level tabs (lg+), left→right per ADR-025. Health is the body hub
// (/health, with workouts + nutrition beneath); Review is the reflection hub
// (/weekly, with /analytics trends beneath).
export const DESKTOP_DESTINATIONS: Destination[] = [
  { key: "today", to: "/", label: "Today", icon: "today", match: ["/"] },
  { key: "coach", to: "/chat", label: "Coach", icon: "coach", match: ["/chat"] },
  {
    key: "health",
    to: "/health",
    label: "Health",
    icon: "health",
    match: ["/health", "/health/workouts", "/health/nutrition"],
  },
  { key: "tasks", to: "/kanban", label: "Tasks", icon: "tasks", match: ["/kanban"] },
  {
    key: "money",
    to: "/finance",
    label: "Money",
    icon: "money",
    match: [
      "/finance",
      "/finance/transactions",
      "/finance/budget",
      "/finance/recurring",
      "/finance/investments",
      "/finance/grow",
    ],
  },
  {
    key: "review",
    to: "/weekly",
    label: "Review",
    icon: "review",
    match: ["/weekly", "/analytics"],
  },
];

// Below-lg bottom bar: five tabs with Coach elevated in the center.
export const BOTTOM_DESTINATIONS: Destination[] = [
  { key: "today", to: "/", label: "Today", icon: "today", match: ["/"] },
  {
    key: "health",
    to: "/health",
    label: "Health",
    icon: "health",
    match: ["/health", "/health/workouts", "/health/nutrition"],
  },
  { key: "coach", to: "/chat", label: "Coach", icon: "coach", match: ["/chat"] },
  { key: "tasks", to: "/kanban", label: "Tasks", icon: "tasks", match: ["/kanban"] },
  {
    key: "money",
    to: "/finance",
    label: "Money",
    icon: "money",
    match: [
      "/finance",
      "/finance/transactions",
      "/finance/budget",
      "/finance/recurring",
      "/finance/investments",
      "/finance/grow",
    ],
  },
];

export type MoreLink = { to: AppPath; label: string; icon: IconKey };
export type MoreGroup = { heading: string; links: MoreLink[] };

// Overflow ("More") destinations, grouped into Review and Account.
export const MORE_GROUPS: MoreGroup[] = [
  {
    heading: "Review",
    links: [
      { to: "/weekly", label: "Weekly Review", icon: "review" },
      { to: "/analytics", label: "Trends", icon: "trends" },
    ],
  },
  {
    heading: "Account",
    links: [
      { to: "/profile", label: "Profile", icon: "profile" },
      { to: "/about", label: "About", icon: "about" },
    ],
  },
];

// Paths that light the "More" trigger's active marker (the Review destinations).
export const MORE_ACTIVE_MATCH = ["/weekly", "/analytics"];

export type WorkspaceConfig = {
  label: string;
  links: readonly { label: string; to: AppPath }[];
};

// Local navigation for each workspace, owned by that workspace's route layout.
export const WORKSPACES: Record<Workspace, WorkspaceConfig> = {
  health: {
    label: "Health",
    links: [
      { label: "Overview", to: "/health" },
      { label: "Workouts", to: "/health/workouts" },
      { label: "Nutrition", to: "/health/nutrition" },
    ],
  },
  money: {
    label: "Money",
    links: [
      { label: "Overview", to: "/finance" },
      { label: "Budget", to: "/finance/budget" },
      { label: "Bills", to: "/finance/recurring" },
      { label: "Transactions", to: "/finance/transactions" },
      { label: "Investments", to: "/finance/investments" },
      { label: "Grow", to: "/finance/grow" },
    ],
  },
  review: {
    label: "Review",
    links: [
      { label: "Weekly Review", to: "/weekly" },
      { label: "Trends", to: "/analytics" },
    ],
  },
};

// --- Pure helpers ----------------------------------------------------------

// Whether `pathname` is under one of a destination's match prefixes.
export function isPathActive(match: string[], pathname: string): boolean {
  return match.some((m) => (m === "/" ? pathname === "/" : pathname.startsWith(m)));
}

// Key of the active destination within a set of tabs, or null.
export function activePrimaryKey(destinations: Destination[], pathname: string): string | null {
  return destinations.find((d) => isPathActive(d.match, pathname))?.key ?? null;
}

// Workspace a path belongs to, or null for global routes.
// Prefer longer link prefixes so /finance/budget maps to money, not a short miss.
export function workspaceForPath(pathname: string): Workspace | null {
  let best: { workspace: Workspace; length: number } | null = null;
  for (const key of Object.keys(WORKSPACES) as Workspace[]) {
    for (const link of WORKSPACES[key].links) {
      const matches =
        link.to === "/"
          ? pathname === "/"
          : pathname === link.to || pathname.startsWith(`${link.to}/`);
      if (matches && (!best || link.to.length > best.length)) {
        best = { workspace: key, length: link.to.length };
      }
    }
  }
  return best?.workspace ?? null;
}

// Whether the app shell should render global navigation for this path.
export function shellShowsNav(pathname: string): boolean {
  return pathname !== "/login";
}
