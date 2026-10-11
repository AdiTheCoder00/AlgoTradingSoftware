---
name: Serene Quant
colors:
  surface: '#0b1326'
  surface-dim: '#0b1326'
  surface-bright: '#31394d'
  surface-container-lowest: '#060e20'
  surface-container-low: '#131b2e'
  surface-container: '#171f33'
  surface-container-high: '#222a3d'
  surface-container-highest: '#2d3449'
  on-surface: '#dae2fd'
  on-surface-variant: '#bdc8d1'
  inverse-surface: '#dae2fd'
  inverse-on-surface: '#283044'
  outline: '#87929a'
  outline-variant: '#3e484f'
  surface-tint: '#7bd0ff'
  primary: '#8ed5ff'
  on-primary: '#00354a'
  primary-container: '#38bdf8'
  on-primary-container: '#004965'
  inverse-primary: '#00668a'
  secondary: '#4edea3'
  on-secondary: '#003824'
  secondary-container: '#00a572'
  on-secondary-container: '#00311f'
  tertiary: '#ffbcbf'
  on-tertiary: '#67001b'
  tertiary-container: '#ff929a'
  on-tertiary-container: '#8c0028'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#c4e7ff'
  primary-fixed-dim: '#7bd0ff'
  on-primary-fixed: '#001e2c'
  on-primary-fixed-variant: '#004c69'
  secondary-fixed: '#6ffbbe'
  secondary-fixed-dim: '#4edea3'
  on-secondary-fixed: '#002113'
  on-secondary-fixed-variant: '#005236'
  tertiary-fixed: '#ffdadb'
  tertiary-fixed-dim: '#ffb2b7'
  on-tertiary-fixed: '#40000d'
  on-tertiary-fixed-variant: '#92002a'
  background: '#0b1326'
  on-background: '#dae2fd'
  surface-variant: '#2d3449'
typography:
  headline-xl:
    fontFamily: Inter
    fontSize: 36px
    fontWeight: '600'
    lineHeight: 44px
    letterSpacing: -0.03em
  headline-xl-mobile:
    fontFamily: Inter
    fontSize: 28px
    fontWeight: '600'
    lineHeight: 36px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Inter
    fontSize: 28px
    fontWeight: '600'
    lineHeight: 36px
    letterSpacing: -0.02em
  headline-lg-mobile:
    fontFamily: Inter
    fontSize: 22px
    fontWeight: '600'
    lineHeight: 30px
    letterSpacing: -0.01em
  headline-md:
    fontFamily: Inter
    fontSize: 20px
    fontWeight: '500'
    lineHeight: 28px
    letterSpacing: -0.015em
  headline-sm:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '500'
    lineHeight: 24px
    letterSpacing: -0.01em
  body-lg:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
    letterSpacing: -0.005em
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
    letterSpacing: 0em
  body-sm:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 18px
    letterSpacing: 0em
  label-numeric-lg:
    fontFamily: JetBrains Mono
    fontSize: 20px
    fontWeight: '500'
    lineHeight: 28px
    letterSpacing: -0.02em
  label-numeric-md:
    fontFamily: JetBrains Mono
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
    letterSpacing: -0.01em
  label-numeric-sm:
    fontFamily: JetBrains Mono
    fontSize: 11px
    fontWeight: '400'
    lineHeight: 16px
    letterSpacing: 0em
  label-caption:
    fontFamily: Inter
    fontSize: 11px
    fontWeight: '500'
    lineHeight: 16px
    letterSpacing: 0.04em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  gutter: 1.25rem
  gutter-desktop: 1.5rem
  margin: 1rem
  margin-desktop: 2rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 1rem
  space-lg: 1.5rem
  space-xl: 2.5rem
---

## Brand & Style

This design system establishes an architectural paradigm for quantitative analysis and institutional-grade trading that rejects the historical visual cacophony of legacy financial terminals. It replaces claustrophobic data grids, flashing indicators, and jarring neon hues with an aura of mathematical composure, deliberate restraint, and clinical precision.

### Personality & Demeanor
- **Composed & Disciplined:** High-frequency precision delivered with low emotional friction. The interface projects stability during peak volatility.
- **Intellectual & Analytical:** Prioritizes clarity of signal over volume of noise. Every pixel exists to aid cognitive decompression and rational decision-making.
- **Architectural Minimalist:** Structured, quiet, and balanced. Heavy structural borders are eliminated in favor of subtle tonal shifts and delicate structural dividers.

### Design Aesthetic
The visual style draws from modern Swiss typography and architectural dark-mode minimalism. Surfaces are treated as physical sheets of matte slate glass layered over a deep void, utilizing soft low-contrast perimeter dividers, generous internal padding, and deliberate atmospheric breathing room. Visual signals (gains, losses, order executions) function as gentle luminescent pings rather than aggressive alerts.

## Colors

The palette is engineered specifically to alleviate prolonged cognitive strain during intensive market sessions while maintaining strict, instantaneous semantic recognition.

### Color Hierarchy & Roles
- **Base Void (`#0b0f19`):** The primary canvas ground. Recedes fully to direct optical focus toward data layers.
- **Base Slate (`#0f172a`):** Primary container surface. Offers a warm, deep blue-slate foundation that neutralizes eye fatigue.
- **Elevated Slate (`#1e293b`):** Secondary container surface and interactive state layer for cards, segmented controls, and nested widgets.
- **Primary Accent (`#38bdf8` - Sky Blue):** Designates interactive controls, focus rings, active navigation items, structural chart lines, and neutral order states.
- **Secondary Accent (`#10b981` - Soft Pastel Emerald):** Denotes positive yield, bid volume, long-side allocations, and positive performance deltas. Calibrated to avoid hyper-saturated eye stress.
- **Tertiary Accent (`#f43f5e` - Muted Crimson):** Reserved for negative yield, ask pressure, short exposure, stop-loss triggers, and risk threshold breaches. Softened from pure red to preserve emotional objectivity.
- **Subtle Borders (`rgba(148, 163, 184, 0.08)` to `rgba(148, 163, 184, 0.16)`):** Atmospheric separators replacing harsh grid dividing lines.
- **Text Layers:** Primary text resides at `#f8fafc` (Slate 50), secondary metadata at `#94a3b8` (Slate 400), and tertiary or disabled text at `#64748b` (Slate 500).

## Typography

The typographic hierarchy balances contemporary editorial clarity with rapid quantitative scanning.

- **Proportional Font (Inter):** Serves all natural language, structural navigation headers, metrics labels, and explanatory prose. Uses tight negative tracking at scale to produce a machined, authoritative presence.
- **Tabular Font (JetBrains Mono):** Mandated for all dynamic values, price feeds, tick sizes, order books, PnL summaries, timestamps, and quant parameters. Guarantees numerical alignment across rapid data updates without horizontal jitter.
- **Case Conventions:** Micro-labels and metric descriptions leverage uppercase caption styling with open tracking (`+0.04em`) to establish visual separation from dynamic tabular outputs.

## Layout & Spacing

The layout model is driven by clean macro-regions, rejecting cramped, multi-window floating tool designs in favor of a cohesive, responsive fluid grid with fixed visual anchors.

### Layout Philosophy
- **Fluid Structural Grid:** A 12-column responsive grid on desktop with generous structural margins. Modular workspaces collapse into organized 6-column views on tablet and single-column stacked analytical cards on mobile devices.
- **Generous Internal Card Padding:** Analytical cards and module panels must never crowd numbers against borders. Internal card padding adheres strictly to `space-lg` (`1.5rem`) on desktop and `space-md` (`1rem`) on compact views.
- **Rhythm & Visual Rest:** Modules are clustered by cognitive domain (e.g., Portfolio Executive Summary, Interactive Execution Engine, Systematic Order Flow). Empty horizontal channels between module rows use `space-xl` (`2.5rem`) to create natural cognitive breaks between distinct analytical routines.

## Elevation & Depth

Visual hierarchy is constructed through tonal layering, faint luminescence, and hairline borders rather than heavy ambient drop shadows.

### Elevation Tiers
1. **Canvas Ground (`#0b0f19`):** Deepest level. Houses global navigation frameworks, status bars, and the broad background canvas.
2. **Base Cards & Workspaces (`#0f172a`):** Layer 1 elevation. Bounded by a 1px border of `rgba(148, 163, 184, 0.08)`. Conveys a grounded, matte surface without drop shadows.
3. **Interactive & Flyout Panels (`#1e293b`):** Layer 2 elevation. Used for dropdown menus, contextual order execution modals, and active trade inspection inspectors. Defined by a 1px border of `rgba(148, 163, 184, 0.16)` paired with a soft ambient shadow (`box-shadow: 0 16px 32px -8px rgba(0, 0, 0, 0.5)`).
4. **Transient Floating Overlays:** Tooltips and cursor hover inspectors utilize solid `#0b0f19` surfaces with an accent rim (`rgba(56, 189, 248, 0.25)`), creating an elevated heads-up display effect directly over charting areas.

## Shapes

The design uses a soft, disciplined geometry (`roundedness: 1`). 

- Standard inputs, buttons, chips, and analytical cards apply a consistent `0.25rem` (4px) to `0.5rem` (8px) radius.
- Large contextual modules and overall card containers use `rounded-lg` (`0.5rem` / 8px).
- Extreme roundedness and full pill shapes are strictly prohibited except for small status pings and live connection indicators. This preserves crisp, linear geometric edges that align seamlessly with quantitative charts and data columns.

## Components

### Buttons
- **Primary Action (Execute / Long / Buy):** `#10b981` background with deep slate `#06281e` text, or `#38bdf8` background with slate `#042031` text. Flat finish with zero gradient. Hover introduces subtle brightness scaling (`1.05`).
- **Secondary Action (Short / Sell):** `#f43f5e` muted background with high-contrast text. 
- **Neutral / Tool Actions:** Background `#1e293b` with `#f8fafc` text and a subtle border `rgba(148, 163, 184, 0.12)`.
- **Button Sizing:** Strict 36px height for default controls, 28px for micro/inline controls, using `label-caption` or `body-sm` typography with medium weight.

### Analytical Cards
- Solid `#0f172a` surface with hairline perimeter lines. 
- Header areas feature clean titling (`headline-sm`) left-aligned, paired with quiet secondary filters or period selectors (`1D`, `1W`, `1M`, `YTD`) on the right.
- Charting card interiors eliminate unnecessary gridlines; axis guidelines are limited to 3 or 4 horizontal rules tinted at `rgba(148, 163, 184, 0.05)`.

### Chips & Badges
- Semi-transparent fills over opaque solid colors. Positive PnL chips render with `rgba(16, 185, 129, 0.1)` background, `#10b981` monospace text, and zero border.
- Risk/Alert chips render with `rgba(244, 63, 94, 0.1)` background and `#f43f5e` text.
- Standard metadata chips employ `rgba(148, 163, 184, 0.08)` background and `#94a3b8` text.

### Input Fields & Sliders
- Background rendered in `#0b0f19` inset with a 1px border of `rgba(148, 163, 184, 0.12)`.
- Focused state transitions border to `#38bdf8` with an unobtrusive glow (`box-shadow: 0 0 0 1px #38bdf8`).
- Numeric stepper buttons integrate seamlessly within the field using monospace digits.

### Data Tables & Lists
- Table headers display in `label-caption` with uppercase `#64748b` text, aligned to the bottom with subtle padding (`space-sm`).
- Rows feature minimal 1px bottom borders (`rgba(148, 163, 184, 0.04)`). Row hover effects apply a soft background tint of `#1e293b` with a instantaneous 100ms transition.
- Alternating zebra row backgrounds are omitted; visual tracking is maintained strictly through generous vertical row height (44px standard) and precise tabular typography.

### Checkboxes & Toggle Switches
- Checkboxes use square 16px boxes with `0.25rem` corners, filled with `#38bdf8` when checked.
- Toggle switches employ a compact 36px x 20px track (`#1e293b`) with an internal floating disc (`#94a3b8`), transitioning to `#38bdf8` background when engaged.