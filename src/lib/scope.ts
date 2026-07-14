/**
 * Data scoping (ADR-017).
 *
 * Two people use this app: Brian and his wife Sophia. Personal data
 * (health, profile, personal tasks) is stored per-user under
 * `assistant/{userScope}/...`; shared household data (finances, shared tasks)
 * lives under `assistant/household/...`.
 *
 * This module is client-safe (no `cloudflare:workers` import) so the UI can
 * label task owners and reason about ownership.
 */

/** Shared household scope prefix segment. */
export const HOUSEHOLD_ID = "household";

/**
 * Stable per-user scope id derived from a login email.
 *
 * The two known accounts get fixed ids. Brian maps to `brian` so all of his
 * pre-existing personal data (already stored under `assistant/brian/...`) stays
 * exactly where it is. Any other (future) allowed email degrades to a slug of
 * the local-part so it still gets an isolated, stable prefix.
 */
const KNOWN_SCOPES: Record<string, string> = {
  "briankimball1982@gmail.com": "brian",
  "sophiamkimball@gmail.com": "sophia",
};

export function resolveUserScope(email: string | null | undefined): string {
  const normalized = (email || "").trim().toLowerCase();
  if (!normalized) return "brian"; // dev escape hatch (no auth configured)
  if (KNOWN_SCOPES[normalized]) return KNOWN_SCOPES[normalized];
  const localPart = normalized.split("@")[0] || normalized;
  const slug = localPart.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "user";
}

/** Human-friendly label for a scope id (used for task ownership badges). */
export function scopeDisplayName(scope: string): string {
  if (scope === HOUSEHOLD_ID) return "Shared";
  return scope.charAt(0).toUpperCase() + scope.slice(1);
}

/** Time-of-day greeting word ("Morning" / "Afternoon" / "Evening"). */
export function greetingTimeWord(date = new Date()): string {
  const h = date.getHours();
  if (h < 12) return "Morning";
  if (h < 18) return "Afternoon";
  return "Evening";
}

/**
 * Time-of-day *context* layer (Contextual Zen Stack). Independent of the
 * light/dark theme — this only decides which content cards surface on the home
 * Action Stack and the ambient background tint, never brightness.
 *   morning  <11am
 *   midday   11am-5pm
 *   evening  >=5pm
 */
export type Daypart = "morning" | "midday" | "evening";

export function getDaypart(date = new Date()): Daypart {
  const h = date.getHours();
  if (h < 11) return "morning";
  if (h < 17) return "midday";
  return "evening";
}

/** "Good morning/afternoon/evening" phrasing keyed to the content daypart. */
export function daypartGreeting(daypart: Daypart): string {
  return daypart === "morning"
    ? "Good morning"
    : daypart === "midday"
      ? "Good afternoon"
      : "Good evening";
}
