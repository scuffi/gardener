# Gardener dashboard design system

The dashboard is built on [Kumo](https://github.com/cloudflare/kumo), Cloudflare's design system
(`@cloudflare/kumo`, exactly pinned). Kumo owns colour, elevation, focus, motion primitives, and
component behaviour. Gardener owns information architecture, density choices, and a small set of
product primitives.

This document is the contract. If a rule here conflicts with existing code, the code is wrong.

Companion documents:

- [`dashboard-redesign.md`](dashboard-redesign.md) — the redesign plan and phase order.
- `apps/gardener/ui/AGENTS.md` — working rules for agents editing the UI.
- `node_modules/@cloudflare/kumo/ai/USAGE.md` — Kumo's own AI usage guide.
- `node_modules/@cloudflare/kumo/ai/component-registry.md` — every component, prop, and example.

---

## 1. Rules

1. **Kumo semantic tokens only.** Never a raw hex value, never a raw Tailwind palette colour
   (`bg-blue-500`, `text-neutral-400`) in product code. The only permitted raw colours are the
   browser-chrome `theme-color` meta values in `index.html` and `theme.tsx`.
2. **Never add `dark:` variants and never redefine a colour token.** See §2 — Kumo already resolves
   both schemes.
3. **Kumo first.** Check the component registry before building anything. Do not hand-roll a table,
   tabs, meter, dialog, empty state, skeleton, or pagination.
4. **Import Kumo only through `ui/primitives`.** One audited surface; never
   `@cloudflare/kumo/components/*` directly in a feature.
5. **Tailwind utilities for layout and spacing.** `styles.css` holds only true globals — reset, font
   stack, focus ring, skip link, scrollbar, keyframes. It must stay under 100 lines.
6. **Every surface implements four states**: loading (skeleton), empty (explains what *would* appear),
   error (`Banner` plus retry), loaded.

## 2. Light and dark

Kumo owns the scheme switch. Do not reimplement it.

- `kumo-binding.css` maps `[data-mode="dark"]` to `color-scheme: dark`.
- `theme-kumo.css` redefines every `--color-kumo-*` and `--text-color-kumo-*` token under that same
  `[data-mode="dark"]` selector.

Therefore:

- `theme.tsx` setting `document.documentElement.dataset.mode` is **correct**.
- The `index.html` inline bootstrap that sets `data-mode` before first paint is **correct** and
  prevents a flash of the wrong scheme.
- Writing `:root[data-mode="dark"] { --some-colour: #abc }` in app CSS is **wrong**. It fights the
  theme. Use the semantic token that already resolves correctly in both schemes.

## 3. Tokens

Use these names directly. Tailwind utility form is shown; the CSS custom property is
`--color-kumo-*` / `--text-color-kumo-*`.

### Surfaces

| Utility | Use for |
| --- | --- |
| `bg-kumo-canvas` | Page background, behind everything |
| `bg-kumo-base` | Default panel / card background |
| `bg-kumo-elevated` | Raised surface — section headers, secondary cards |
| `bg-kumo-recessed` | Inset surface — segmented control tracks, code wells |
| `bg-kumo-tint` | Hover and zebra states |
| `bg-kumo-contrast` | Inverted, high-contrast background |

### Text

| Utility | Use for |
| --- | --- |
| `text-kumo-strong` | Headings and emphasised values |
| `text-kumo-default` | Body text |
| `text-kumo-subtle` | Descriptions, captions, secondary labels |
| `text-kumo-inactive` | Disabled text |
| `text-kumo-placeholder` | Input placeholders |
| `text-kumo-inverse` | Text on `bg-kumo-contrast` or a brand fill |
| `text-kumo-link` | Links |

### Borders

| Utility | Use for |
| --- | --- |
| `border-kumo-hairline` | Divider between flat surfaces with no shadow |
| `border-kumo-line` | Edge of an elevated surface that also has a shadow |

### Brand and status

Kumo's own `--color-kumo-brand` is **blue**. Gardener redefines it in `ui/accents.css`, which is
the only file in the UI allowed to hold a colour value. The accent is selectable: Cloudflare
orange (default) or Gardener green, chosen in Settings and stored as `data-accent` on `<html>`.

`bg-kumo-brand` and `text-kumo-brand` resolve to **different** colours on purpose. Cloudflare
orange is 2.52:1 on the light canvas, so it is a fill only; the text token is a darker orange at
4.59:1. Use `bg-kumo-brand` when a label sits on top of the colour, and `text-kumo-brand` when the
colour sits on the canvas. Full table and measurements: `docs/dashboard-redesign.md` §6.1.

| Utility | Meaning in Gardener |
| --- | --- |
| `kumo-brand` | **Primary.** Primary buttons, active nav, focus, live indicators. Accent-dependent. |
| `kumo-info` | Informational only. Links, neutral notes, "observing". Never a primary action. |
| `kumo-success` | Executed, healthy, enabled, connected. Gardener's secondary identity colour. |
| | ⚠️ Under the green accent, brand and success are both green (hue 147 vs 163). Never put a brand-filled control and a success badge in the same row without another differentiator. |
| `kumo-warning` | Awaiting a human decision, paused, degraded. |
| `kumo-danger` | Failed, blocked, access removed, destructive actions. |

Solid tokens (`bg-kumo-success`) are for icons, status dots, and meter fills. Badges and banners use
Kumo's own reduced-opacity treatment — pass a `variant`, do not build the fill yourself.

## 4. Status semantics

One vocabulary across every surface. `primitives/status-badge.tsx` is the single implementation.

| Domain state | Tone |
| --- | --- |
| `completed`, `executed`, `enabled`, `active`, `connected` | `success` |
| `queued`, `pending`, `executing`, `awaiting_approval`, `paused` | `warning` |
| `failed`, `completed_with_errors`, `blocked`, `rejected`, `access_removed` | `danger` |
| `observing`, `simulated`, `draft` | `info` |
| `disabled`, `dismissed`, `none` | `neutral` |

## 5. Typography

| Role | Family | Notes |
| --- | --- | --- |
| UI and prose | `Inter Variable` | Default on `body`. |
| **The machine layer** | `JetBrains Mono Variable` | Run IDs, source hashes, revision numbers, operation kinds (`issue.comment.create`), policy keys, receipts, repository IDs, diagnostic paths. |

The mono/sans split is load-bearing, not decorative: it is how an operator tells Gardener's own
prose apart from exact machine identifiers. Apply it consistently via `Text variant="mono"` or the
`font-mono` utility. Never use mono for body copy.

Scale: Kumo's `text-xs` / `text-sm` / `text-base` / `text-lg`.

Two Kumo `Text` gotchas worth knowing before you use it:

- It takes **`DANGEROUS_className`**, not `className`.
- Its `heading1` / `heading2` / `heading3` variants are **deprecated**. Use `variant="heading"` with
  an explicit `size` and `as`, or — for page and section titles that need a ref, `tabIndex`, or
  layout classes — a plain `<h1>`/`<h2>` carrying token utilities. `PageHeader` and `PanelHeader`
  already do this correctly; prefer them.
- `variant="success"` currently resolves to `text-kumo-link`, not a success colour. For green text
  use the `text-kumo-success` utility directly.

## 6. Density

Chosen per surface, not globally.

| Density | Surfaces | Base text | Row height |
| --- | --- | --- | --- |
| **Instrument** | Runs, Audit, Authority matrix, all tables | `text-sm` | 32px |
| **Decision** | Inbox detail, Agent editor, publishing, Setup, Sign-in | `text-base` | comfortable, generous padding |

Decision surfaces get exactly one unmistakable primary action.

## 7. Motion

Purposeful only: live-run pulse, status transitions, streaming step appends, gate unlocks. No
decorative ambient animation. Everything must be disabled under `prefers-reduced-motion: reduce`,
which `styles.css` enforces globally.

## 8. Product primitives

Everything in `ui/primitives` is either a curated Kumo re-export or a thin Gardener-specific
composition. Add here only when a pattern appears on three or more surfaces.

| Primitive | Purpose |
| --- | --- |
| `PageHeader` | Title, description, actions; manages initial focus for accessibility |
| `SectionHeader` | Header row inside a `Surface` |
| `StatusBadge` / `RunStatus` | The §4 status vocabulary |
| `Stat` | A single metric cell for Overview and summary strips |
| `GateRail` | The draft → publish → activate → enable lifecycle visual |
| `Mono` | The §5 machine layer, with copy affordance where useful |
| `PageSkeleton`, `TableSkeleton`, `CardSkeleton` | Loading states built on Kumo `SkeletonLine` |
| `EmptyState`, `ErrorState`, `LoadingState` | The four-state contract |

## 9. Charts

Kumo's `Chart` / `TimeseriesChart` require the consumer to pass an ECharts instance via the
`echarts` prop so the consumer controls bundling. `echarts` is pinned exactly and imported
tree-shaken (core plus only the used chart and renderer modules) from `ui/lib/echarts.ts`. Never
`import * as echarts from "echarts"` in a feature.

## 10. Accessibility

- Serious and critical Axe violations are release blockers, in both schemes, at 360px and 1280px.
- Every surface fully keyboard traversable; visible focus everywhere (Kumo's `kumo-focus` ring).
- Status is never colour-only — always pair with text or an icon.
- One `h1` per surface, headings in order, landmarks correct.
- Interactive targets at least 24×24px, 44×44px on touch.
