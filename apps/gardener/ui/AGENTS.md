# Working rules: `apps/gardener/ui`

Read this before editing anything in this directory. It exists so that a coding agent can extend the
dashboard without reverse-engineering it or drifting from the design system.

Required reading, in order:

1. This file.
2. [`docs/design-system.md`](../../../docs/design-system.md) — tokens, density, status vocabulary.
3. `node_modules/@cloudflare/kumo/ai/USAGE.md` — Kumo's own AI usage guide.
4. `node_modules/@cloudflare/kumo/ai/component-registry.md` — every Kumo component, prop, and
   example. Search it before writing a component; Kumo ships 41 of them.

Background on why the UI looks the way it does: [`docs/dashboard-redesign.md`](../../../docs/dashboard-redesign.md).

---

## Hard rules

These are mechanically checkable and are enforced in review.

1. **Max 120 characters per line.** No exceptions. The pre-redesign code had 1,622-character lines,
   which cannot be patched by exact-match edits or reviewed in a diff. Do not recreate that.
2. **One exported component per file**, named after the file. `run-graph.tsx` exports `RunGraph`.
3. **Multi-line JSX.** If an element has more than two props, put each prop on its own line. Never
   chain multiple statements onto one line with `;`.
4. **Import Kumo only from `../../primitives`.** Never `@cloudflare/kumo/...` inside `features/`.
   If you need a Kumo component that is not re-exported yet, add it to `primitives/index.ts` in the
   same change.
5. **Kumo semantic tokens only.** No raw hex, no raw Tailwind palette colours, no `dark:` variants,
   never redefine a `--color-kumo-*` token. See `docs/design-system.md` §2 and §3.
6. **No new CSS in `styles.css`** unless it is a genuine global (reset, font, focus, keyframes).
   Use Tailwind utilities. `styles.css` must stay under 100 lines.
7. **Query keys come from `lib/query-keys.ts`.** Never an inline `queryKey: ["thing"]` array.
8. **Types come from `lib/types.ts`; API calls from `lib/api.ts`.** Features do not call `fetch`.

## Adding a surface

This is the whole procedure. It should touch no shared file except `routes.ts`.

1. Add one entry to `ui/routes.ts`. Navigation, breadcrumbs, the document title, and the `⌘K`
   command palette all derive from that entry — do not edit the shell, the sidebar, or the palette.
2. Create `ui/features/<name>/<name>-page.tsx` exporting the component named in the route entry.
3. Put anything it needs in `ui/features/<name>/components/` and `ui/features/<name>/hooks.ts`.
   Keep it local until a third surface needs it, then promote to `primitives/`.
4. Implement all four states: loading, empty, error, loaded. A surface with no empty state is
   incomplete.
5. Add a query key to `lib/query-keys.ts` if it fetches.

Step 1 is genuinely sufficient for navigation: `ui/actions.ts` derives the ⌘K palette from the same
registry, and `ui/actions.test.ts` fails if a sidebar surface is ever missing from it. Routes whose
path contains `:` are excluded automatically, because they cannot be navigated without an id.

## Adding a guarded action

Actions that change state (pause, activate, enable, approve, publish) belong in `ui/actions.ts` so
the command palette, keyboard shortcuts, and confirmation copy stay in one place. Feature-local
buttons may call the same mutation, but anything an operator might reach for from anywhere should
be in the palette.

**An action names the exact operation it performs** — never a generic "Approve" or "Confirm", and
label it by what it will do, not by the current state ("Pause Gardener globally", not "Paused").
Use `ConfirmDialog` from `primitives` for anything that widens authority or destroys data.

## Directory map

```
ui/
  AGENTS.md            this file
  app.tsx              route table assembly only
  main.tsx             providers and bootstrap only
  app-context.tsx      shared health / state / session
  routes.ts            SINGLE SOURCE OF TRUTH for routes + nav + palette
  styles.css           globals only, <100 lines
  theme.tsx            scheme preference; sets data-mode (Kumo's switch). No colours.
  primitives/          the ONLY place Kumo is imported (kumo.ts + Gardener primitives)
  shell/               app chrome: app-shell, account-menu, automation-menu, skip-link
  providers/           notifications
  features/<name>/     one folder per surface
  lib/                 api.ts, types.ts, format.ts, query-keys.ts
```

Arriving in later phases, per [`docs/dashboard-redesign.md`](../../../docs/dashboard-redesign.md):
`actions.ts` (guarded action registry + `⌘K` palette, phase 1) and `lib/echarts.ts` (tree-shaken
ECharts modules for the Overview charts, phase 6).

## Conventions

- **State**: TanStack Query for everything server-owned. `app-context.tsx` exposes shared
  health/state/session. No Redux, no new global store.
- **Routing**: `react-router-dom`. Links render through Kumo's `LinkProvider`, already wired in
  `main.tsx`, so use Kumo `Link`/`Button` `href` rather than raw `<a>`.
- **Icons**: `@phosphor-icons/react`, sized 16–20 in UI chrome. Always `aria-hidden` when decorative.
- **Notifications**: `useNotifications().notify({ tone, title, description })`. Errors persist;
  successes auto-dismiss.
- **Formatting helpers**: `lib/format.ts`. Do not inline date or cost formatting.
- **Accessibility**: see `docs/design-system.md` §10. Serious/critical Axe issues block release.
- **Navigation targets**: if a collection card or row has one destination, make the whole surface
  keyboard-accessible. Use `CardLink` for cards; do not bury navigation in a linked title.

## Verify before finishing

```bash
pnpm ui:check                             # enforces the hard rules below; run this first
pnpm --filter @gardener/app typecheck     # both tsconfigs
pnpm --filter @gardener/app test
pnpm --filter @gardener/app build
```

`pnpm ui:check` (`scripts/check-ui-conventions.mjs`, also part of `pnpm check`) mechanically
enforces: the 120-char limit, no Kumo import outside `primitives/`, no raw hex or Tailwind palette
colours or `dark:` variants, no inline `queryKey` arrays, the `styles.css` budget (max 80 effective
lines, no hex, no `--gd-*`, no `[data-mode]` overrides, no `!important`), and that `accents.css`
stays a pure token layer.

**Colour lives in two files and nowhere else.** `ui/accents.css` defines the signature brand green;
`features/auth/ascii-garden.css` defines the decorative garden palette. Everything else uses Kumo
semantic tokens. Action fill, canvas text, and decorative display greens are deliberately distinct
— see `docs/dashboard-redesign.md` §6.1 before touching them. `ui/accents.test.ts` pins
the contrast numbers, so a colour change that breaks WCAG fails the suite.

If a raw colour is genuinely unavoidable, put a `design-system-exempt: <reason>` comment on the
line or just above it. Exemptions are printed on every run so they cannot pile up unnoticed. There
is currently exactly one, in `theme.tsx`.

The checker cannot see everything. Still self-check by hand: all four states present (loading,
empty, error, loaded), light and dark both sane, and keyboard focus visible throughout.
