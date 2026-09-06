# Design system

One token source, three surfaces, gates that fail closed. This document is the
doctrine; `design/tokens.yaml` is the source; `scripts/design-build.js` is the
compiler; `test/design.test.js` is what makes a drift or a hand edit fail CI.

```
design/tokens.yaml ──► scripts/design-build.js ──► src/ui/styles.css        (generated block: dashboard + offline snapshot)
                              │ gates              site/styles.css          (generated block: landing page)
                              └──────────────────► menubar/TokenFlow/DesignTokens.swift  (whole file: menu bar)
```

```bash
npm run design          # compile + write
npm run design:check    # compile in memory, diff, exit 1 on drift or a failed gate
```

Edit the YAML, run `npm run design`, commit the result. Never edit inside a
`@generated design-tokens` block; the test diffs it against the compiler.

---

## 1. Roles, not values

Every colour is named for the job it does: `--plane`, `--surface-1`,
`--text-muted`, `--accent`, `--border-strong`. Nothing is named for how it looks.
A role stays true when a skin flips mode or is replaced; `--grey-200` becomes a
lie the moment the palette changes. (Borrowed from design-kit's schema.)

## 2. Two axes, kept apart

| Axis | Values | Owns |
|---|---|---|
| `data-mode` | dark · light | ink polarity, surfaces, **the series steps** |
| `data-skin` | aurora · terminal · editorial | the room: surfaces, borders, accent, density, display face |

The categorical, sequential and diverging steps belong to the **mode**. They were
validated against every skin's chart surface, so a skin restyles the room and
never the data. Switching theme must not change what a colour means.

**Fidelity beats variety.** Three skins are enough. A fourth is a deliberate
decision with a stated reason, not a Friday afternoon.

## 3. Hierarchy is carried by lightness, never by hue

- The plane is the room. A card **lifts** toward the light in both modes.
- Wells inside a card (`--surface-2`, `--surface-3`) **nest** away from the card:
  lighter still in dark mode, greyer in light mode. The compiler checks both
  directions.
- The accent is an accent. It marks the selected thing, the primary action, the
  live pill. It never floods a surface. A gradient is allowed in exactly one
  place: behind a single hero number (`--hero-glow`), never behind a mark whose
  colour has to stay comparable.
- Status colours (`--good`, `--warning`, `--serious`, `--critical`) are reserved
  for state. They are never a series, never a chart mark, never themed, and
  always travel with an icon or a word. On light surfaces `warning` and
  `critical` sit near series 4 and 8; the compiler reports that as a documented
  relief, not as a pass.

## 4. Type

The dashboard and menu bar use the platform's faces (`system-ui`, `ui-monospace`,
the platform serif). They ship optical sizing and tracking tables, and the
offline snapshot must open from `file://` with nothing to fetch.

Tracking and leading are **size-specific**: large text tightens, small text
opens. One `letter-spacing` for every size is wrong somewhere.

| Step | Size | Tracking | Leading | Used for |
|---|---|---|---|---|
| micro | 10.5 | +.02em | 1.3 | axis ticks, badges |
| label | 11.5 | +.012em | 1.35 | KPI labels, hints |
| caption | 12.5 | +.004em | 1.4 | table cells, card titles |
| body | 13.5 | 0 | 1.45 | body, controls |
| title | 15 | −.006em | 1.3 | dialog titles |
| figure | 25 | −.015em | 1.12 | KPI values |
| hero | 42 | −.025em | 1.05 | the one number on a view |
| display | 60 | −.03em | 1.0 | landing headlines |

Every number wears `font-variant-numeric: tabular-nums`. Text wears text tokens,
never a series colour; a coloured mark beside it carries identity.

The landing page has a voice of its own: Space Grotesk for display, IBM Plex
Sans for body, IBM Plex Mono for figures — design-kit's `house-plex` pairing,
self-hosted under `site/fonts/` (OFL-1.1). A sans display is the default for a
developer tool; a serif would need a brand reason this product does not have.
A product whose promise is "nothing leaves your machine" does not load fonts
from a third party.

## 5. Space, radius, elevation

A 4-pt scale (`--sp-2` … `--sp-72`) with the two half-steps dense layouts use.
Radii are per skin (`aurora` 14/9, `terminal` 5/4, `editorial` 8/6) because
corner radius is part of a room's character. Shadows are tinted toward the
skin's hue, never neutral black; a bigger surface reads as thicker (deeper
shadow, stronger blur) than a chip.

## 6. Motion — two tiers, one doctrine

| Tier | Governs | Values |
|---|---|---|
| `ui` | dashboard, menu bar | press 120ms · fast 160ms · base 220ms · slow 300ms · stagger 40ms (max 6) |
| `narrative` | landing, reveals | fast 180ms · base 320ms · slow 700ms · stagger 85ms (max 7) |

Rules (Emil Kowalski, Apple, design-kit, in agreement):

- **Should it animate at all?** Something seen a hundred times a day does not.
  Keyboard-initiated actions never animate. The compiler refuses a UI value over
  300ms.
- **Every animation carries information** — sequence, causality, comparison,
  magnitude. Motion that only decorates is deleted.
- **Ease-out for entrances, ease-in-out for on-screen movement, never ease-in.**
  Custom curves (`--ease-out`, `--ease-in-out`, `--ease-drawer`); the built-ins
  are too weak.
- **Feedback on press, not on release.** Every pressable scales to `.97` on
  `:active` at `--dur-press`.
- **Popovers scale from their trigger** (`transform-origin` at the trigger);
  modals stay centred.
- **Tooltips delay once, then are instant** for neighbours.
- **Enter from `scale(.96)` + opacity, never from `scale(0)`.** Use
  `@starting-style` for entry.
- **Transitions over keyframes** for anything that can be re-triggered; specify
  properties, never `transition: all`.
- **Stagger only when a view changes**, 40ms apart, at most six items. Never
  front-load then freeze; once content has resolved it holds still.
- **Hover states are gated** behind `(hover: hover) and (pointer: fine)`.
- **Reduced motion degrades to an instant, complete state** — never a broken
  half-state. Transparency and contrast preferences are honoured the same way.

## 7. Charts

Ramps are **authored, never derived**. The eight categorical steps, the seven
sequential steps and the five diverging steps live in the token file and pass
the compiler's gates on every build:

| Gate | Threshold | Shipped |
|---|---|---|
| series on each skin's chart surface | ≥ 3:1 | pass in dark; light slots 3–5 are the documented relief |
| adjacent series distance (CIE76 ΔE) | ≥ 20 | worst 76 dark · 84 light |
| first three slots, all pairs | ≥ 20 | pass |
| sequential luminance | strictly monotonic | pass |
| diverging ends / midpoint | ends ΔE ≥ 40 · midpoint near-neutral | pass |
| status vs series | ≥ 12 hard, < 20 reported | light `warning`/`critical` are the documented relief |

Rules that hold in every chart (dataviz):

- Colour is assigned to the **entity, in fixed order, never by rank**. A filter
  that removes a series never repaints the survivors. Past eight, fold into
  "Other".
- **One axis.** Two measures of different scale are two charts.
- Sequential is one hue light→dark; diverging is two hues with a neutral grey
  midpoint. Never a rainbow.
- Thin marks, 2px lines, hairline grid, recessive axes, selective direct labels.
- A legend is always present for two or more series; a single series needs
  none.
- **Every chart has a table twin.** No value is reachable only by hovering.
  This is the relief that lets three light-mode slots sit under 3:1.

## 8. Surfaces

| Surface | Consumes | Notes |
|---|---|---|
| Dashboard | `src/ui/styles.css` generated block | hand-authored components below the block |
| Offline snapshot | the same stylesheet, inlined | one file; that is why the block lives inside `styles.css` |
| Menu bar | `DesignTokens.swift` | every role is a dark/light pair resolved by appearance |
| Landing | `site/styles.css` generated block | single world (Aurora dark), narrative motion tier, self-hosted faces |

## 9. What the compiler cannot measure

These are review rules. The compiler prints them; a person enforces them.

- **Rationing.** One accent per view. One hero number per view. A status colour
  appears only with the word it qualifies.
- **The point.** Every view should answer a question in its first line. A grid
  of numbers you have to interpret is a failure of hierarchy, not of data.
- **Honesty.** Missing is not zero; estimated and measured never mix; a cap
  table is an upper bound; a receipt says what it did not count.

## 10. How to change something

1. Edit `design/tokens.yaml`. Quote every hex (`#` starts a YAML comment).
2. `npm run design`. Read the report; a warning is information, a failure is a
   stop.
3. `npm test`. `test/design.test.js` checks the gates and that every target is
   current.
4. Look at it. Render the dashboard, the snapshot and the landing before
   claiming done; the compiler measures colour, not layout.
