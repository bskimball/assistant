# ADR-025: Compass Visual and Navigation System

**Status**: Accepted
**Date**: 2026-07-15
**Deciders**: Brian Kimball

## Context

Compass has grown from a daily dashboard into a multi-domain application. Its navigation and visual treatment must remain calm and legible while making the primary workspaces easy to reach on desktop and mobile. Existing translucent navigation, route-specific visual treatments, and nested top-level menus do not provide a sufficiently stable hierarchy or a consistent surface system.

The application needs one theme-aware visual language that preserves clear semantics, supports atmospheric backgrounds without sacrificing readability, and keeps navigation predictable as Health and Review gain their own workspace routes.

## Decision

### 1. Mineral crimson semantic palette

Adopt a **mineral crimson** palette as the Compass semantic system:

- mineral neutrals define the page ground, text, borders, and elevated surfaces;
- crimson is the primary brand and action color;
- success, warning, destructive, informational, and chart colors remain distinct semantic tokens rather than decorative substitutes for crimson;
- light and dark themes use separately tuned token values, not mechanical color inversion;
- focus, hover, selected, disabled, and destructive states must remain distinguishable without relying on color alone.

Route code consumes semantic tokens. It must not introduce isolated hard-coded brand colors that bypass the shared theme.

### 2. Opaque compact navigation shelf

The primary navigation is an **opaque, compact shelf** with a clearly selected destination. It may use elevation, borders, or restrained shadows to separate itself from the surrounding atmosphere, but it does not depend on backdrop blur or transparent glass for legibility.

At the `lg` breakpoint and above, the shelf exposes six top-level destinations in a fixed order:

1. Today
2. Coach
3. Health
4. Tasks
5. Money
6. Review

Below `lg`, five primary tabs remain directly reachable and a **More** control exposes the remaining destination and secondary utilities. More uses the responsive disclosure appropriate to available space: a sheet on constrained mobile viewports and a popover where there is sufficient room. The disclosure must be keyboard accessible, identify the active nested destination, and close after navigation.

### 3. Static local navigation for Health and Review

Health and Review are real top-level workspaces, not top-level dropdown groups. Each workspace owns persistent, static local navigation within its route layout:

- Health provides stable access to its overview and health-domain destinations, including workouts and nutrition.
- Review provides stable access to weekly review and trends/analytics.

Local navigation remains visible in the workspace context and does not change based on hover. This preserves direct URLs, active-state clarity, keyboard operation, and room for future destinations without expanding the primary shelf.

### 4. Theme-aware logo variants

Compass provides explicit light-theme and dark-theme logo variants. The rendered variant follows the effective application theme, including the initial page render, without applying CSS filters to approximate the alternate artwork. The logo retains accessible brand text or an appropriate accessible name; decorative duplicate marks remain hidden from assistive technology.

### 5. Graduated atmosphere and surfaces

Visual depth is expressed as a controlled progression rather than uniform glassmorphism:

1. **Atmosphere** — optional route or daypart background treatment;
2. **Page ground** — theme-controlled wash that protects text contrast;
3. **Section surface** — restrained grouping for related content;
4. **Card surface** — opaque or near-opaque content container;
5. **Interactive surface** — controls with explicit hover, focus, pressed, and selected states.

Foreground content must remain readable if background artwork is absent, delayed, disabled, or replaced. Decorative atmosphere never carries required meaning.

### 6. Responsive background behavior

Atmospheric backgrounds adapt to viewport capability:

- desktop may use full-bleed, fixed, or layered artwork when it does not impair scrolling or readability;
- mobile uses a crop, gradient, or simplified treatment designed for narrow and tall viewports and avoids fixed-background behavior that causes rendering or scroll issues;
- image selection and positioning account for light/dark theme and preserve useful focal areas;
- reduced-motion, data-saving, failed-image, and offline states retain a complete token-based background;
- background overlays and surface opacity are graded together so content contrast is stable at every breakpoint.

### 7. CSS grading

Visual changes are accepted through CSS grading at representative light/dark and mobile/desktop states. Grading evaluates:

- semantic token use and absence of route-local palette drift;
- text, icon, focus-ring, and control-state contrast;
- visible hierarchy across atmosphere, ground, sections, cards, and controls;
- opaque navigation readability over every supported background;
- active destination clarity in primary and local navigation;
- mobile cropping, safe-area spacing, scroll behavior, and disclosure usability;
- graceful rendering with background images unavailable.

The grade is a release gate for visual-system changes; aesthetic consistency is not inferred solely from successful type checking or builds.

## Consequences

**Positive**

- Compass gains a recognizable, theme-aware visual identity with stable semantics.
- Six desktop destinations remain directly scannable while mobile navigation stays compact.
- Static Health and Review navigation improves discoverability and accessibility over nested hover/dropdown navigation.
- Opaque surfaces preserve legibility across atmospheric imagery and failure states.
- CSS grading makes visual regressions explicit and repeatable.

**Negative**

- Separate logo assets and theme-specific background tuning require ongoing maintenance.
- Responsive shelf and More disclosure behavior require validation at several viewport widths.
- Stronger surface opacity reduces the amount of background artwork visible behind dense content.
- Moving Health and Review to workspace routes requires coordinated route and active-state handling when implemented.

## Alternatives considered

- **Keep translucent glass navigation** — rejected because legibility varies with artwork and backdrop-filter support.
- **Keep Health and Review as top-level popover groups** — rejected because child destinations are less visible and harder to orient within.
- **Show all six destinations identically at every width** — rejected because narrow screens produce cramped labels and unreliable tap targets.
- **Use one logo and recolor it with CSS filters** — rejected because filters are brittle and do not guarantee intentional theme-specific contrast.
- **Remove atmospheric backgrounds entirely** — rejected because atmosphere is part of the approved Compass identity; the surface system instead constrains it.

## Validation

- Desktop widths at and above `lg` show the six destinations in the approved order with an unambiguous active state.
- Below `lg`, five primary tabs and More remain usable without clipping; the responsive sheet/popover exposes the remaining destination and closes after selection.
- Health and Review child routes expose static local navigation and preserve direct-link and active-state behavior.
- Light, dark, initial-load, and theme-change states render the correct logo variant without a contrast flash.
- CSS grading passes representative Today, Coach, Health, Tasks, Money, and Review screens in light/dark desktop and mobile states.
- Keyboard navigation, visible focus, screen-reader names, safe-area spacing, background failure, and mobile scrolling are manually verified.
- `npm run check`, `npm run test`, and `npm run build` pass when the system is implemented.
