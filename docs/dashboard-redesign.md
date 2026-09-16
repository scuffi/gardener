# Gardener dashboard redesign

Status: approved; implementing phase by phase.
Scope: `apps/gardener/ui/**` plus the small read-only API additions needed to make the runtime visible.

**Decisions taken (2026-09-11):**

1. `echarts` is adopted — exact pin plus a `minimumReleaseAgeExclude` entry, tree-shaken import.
   Overview charts are in scope.
2. Phase 0 lands first, as one codebase-wide mechanical commit.
3. Implementation proceeds phase by phase, with a review checkpoint at each phase boundary.

---

## 1. Verdict

The current dashboard is a competent mid-density admin panel. That is the problem. Gardener is an
agentic software factory that runs autonomous workers against people's repositories under an explicit
authority model, and the UI presents that as six CRUD list pages. Nothing in the product tells the
story of the product.

Measured state of `apps/gardener/ui` (2,068 lines):

| Signal | Measured | Why it matters |
| --- | --- | --- |
| Hand-written CSS | 678 lines, 185 class selectors | A bespoke design system competing with Kumo |
| Dead CSS selectors | 30 of 185 (16%) | Includes a complete run-detail design that is never rendered |
| Hardcoded hex colours | 44 occurrences, 32 unique | Bypasses Kumo tokens; breaks on theme change |
| `!important` | 29 | Overriding Kumo rather than using it |
| `[data-mode="dark"]` colour overrides | 3 blocks | Redefines colour with raw hex *inside Kumo's own dark scope* — fights the theme instead of extending it |
| `--gd-*` re-alias tokens | 30 | Indirection layer that hides the real token names from humans and agents |
| Longest source line | 1,622 chars (`agent-detail-page.tsx`) | 55 lines exceed 200 chars — unreviewable, unpatchable |
| Kumo components available / used | 41 available, ~12 used | Paying the dependency cost, skipping the value |
| Largest UI component | `ascii-garden.tsx`, 329 lines | Noted for scale only. **Kept** — see §11. The problem was never that the garden exists, it is that no comparable effort went into the product surfaces |
| Run observability surface | **does not exist** | `/api/runs/:id` already serves nested tasks, steps, effects |
| Overview / home surface | **does not exist** | The `Metric` component is exported and imported by nobody |

Two findings deserve to be called out on their own.

**The flagship surface is missing.** `GET /api/runs/:id` already returns the run plus its `tasks`
(with `parent_task_id`, `parallel_group`, `depth`), `steps` (with `attempt_count`, `max_attempts`)
and `effects` (with `policy_mode`, `decided_at`, `executed_at`). This is the product. There is no
page, no route, and no API client method for it. Someone even wrote the CSS
(`.run-detail-summary`, `.detail-section`, `.proposal-list`, `.proposal-item`, `.error-detail`) and
then never built the component. The PRD says "Run pages show nested parallel tasks/steps, model/
workspace usage, redacted evidence/artifacts, waits, effects, receipts, retries, and cancellation."
None of it is reachable.

**It does not look like a Cloudflare project.** Kumo's brand token is `#f6821f`. The app uses blue as
its primary accent throughout and demotes Cloudflare orange to a 7px decorative dot on the logo mark.
`CloudflareLogo` and `PoweredByCloudflare` ship in the dependency and are unused.

---

## 2. Root causes

Fixing pages one at a time will not work, because the failures are systemic.

1. **A shadow design system.** `styles.css` defines `--gd-canvas`, `--gd-surface`, `--gd-blue` … as
   aliases of Kumo tokens, then overrides them with raw hex in dark mode. Kumo's tokens already
   resolve per-scheme via `light-dark()`. The alias layer converts a working theme system into a
   half-broken one and guarantees that every new component drifts.
2. **No information architecture.** Navigation is grouped by noun (`Operate`, `Authority`, `System`)
   and the user lands in `/inbox`, an undifferentiated stack of cards. There is no answer to "what is
   my factory doing right now", which is the only question an operator actually has.
3. **The authority model — the genuinely novel idea — is invisible.** Draft → validate → simulate →
   publish paused → activate → enable is six distinct gates rendered as ordinary buttons in a sidebar.
   Policy modes live on a separate page from the repositories they apply to. Nothing visualises
   "instructions cannot grant authority", which is the whole security thesis.
4. **The source is machine-hostile.** Single-line JSX blocks of 500–1,600 characters cannot be
   patched by exact-match edits, cannot be reviewed in a diff, and cannot be reasoned about in
   isolation. This directly conflicts with the requirement that coding agents maintain this codebase.
5. **Effort is unevenly distributed.** 329 lines of animated ASCII grass; zero lines of run
   inspection. The fix is to raise the product surfaces to match the care already spent on the
   sign-in screen, not to level the sign-in screen down.

---

## 3. Design direction

**Positioning: an instrument panel for an autonomous factory, not a settings app.**

Three principles, in priority order when they conflict.

1. **Show the machine working.** Live state is the hero on every surface. Runs, steps, retries,
   waits, and effects stream in. Idle states explain what *would* appear, not just "nothing here".
2. **Authority is always legible.** Every screen that can cause a write shows what authority permits
   it and which gate is still closed. Operators should never wonder what an agent is allowed to do.
3. **Dense where it is data, generous where it is a decision.** Tables, trees, and timelines get
   instrument density. Approvals and publishing get space, weight, and an unambiguous primary action.

### Identity

| Element | Decision |
| --- | --- |
| Primary accent | **Luminous system green** via `kumo-brand` — primary buttons, active nav, focus, and live indicators. |
| Informational accent | Blue via `kumo-info` — links and neutral information only. Never a primary action. |
| Status green | `kumo-success` means healthy or executed. It is status, not generic Gardener chrome. |
| Status semantics | `kumo-success` executed · `kumo-warning` awaiting decision · `kumo-danger` failed/blocked · `kumo-info` observing · `kumo-subtle` paused |
| Typeface | Inter Variable for prose and UI. **JetBrains Mono for the machine layer** — run IDs, source hashes, operation kinds, receipts, revision numbers, policy keys. Applied deliberately and consistently, this single change does more for "software factory" than any illustration. |
| Cloudflare presence | Minimal muted text only. Never use the large `PoweredByCloudflare` banners in product chrome. |
| Motion | Purposeful and calm: stable geometry, soft accent washes, and restrained route transitions. All behind `prefers-reduced-motion`. |
| Decoration | Earned, not sprinkled. The sign-in ASCII garden stays exactly as built — it is the product's signature. Decoration is not added elsewhere without the same level of craft. |
| Accent | One vibrant system green. Brand marks use `#34c759` in light mode and `#30d158` in dark mode; white-label controls use a deeper accessible fill. Defined in `ui/accents.css`; see §6.1. |

---

## 4. New information architecture

Navigation is reorganised around the operator's questions, not the data model's nouns.

| # | Route | Surface | Answers | Status |
| --- | --- | --- | --- | --- |
| 1 | `/` | **Overview** | "What is my factory doing?" | **new**, becomes home |
| 2 | `/inbox` | **Inbox** | "What needs me?" | rebuilt as triage |
| 3 | `/runs`, `/runs/:id` | **Runs** | "What happened, exactly?" | **new — flagship** |
| 4 | `/agents`, `/agents/:id`, `/agents/:id/edit` | **Agents** | "What have I built?" | rebuilt |
| 5 | `/authority` | **Authority** | "What may Gardener do, and where?" | **merges** Repositories + Policies |
| 6 | `/audit` | **Audit** | "Prove it." | replaces History |
| 7 | `/settings` | **Settings** | "How is this instance wired?" | tightened |

Changes from today: home moves from Inbox to Overview; Runs is created; Repositories and Policies
merge into Authority; History is reframed as Audit. Nav groups collapse from three to two —
**Operate** (Overview, Inbox, Runs, Agents) and **Govern** (Authority, Audit, Settings).

Global additions:

- **`⌘K` command palette** (`CommandPalette`) — jump to any agent/run/repository, and run every
  guarded action (pause all, activate revision, approve effect). This is both the modern-feel win and
  the machine-readable action registry; the same registry drives the palette and the docs.
- **Persistent kill switch.** Global pause is a first-class, always-visible app-bar control with an
  unmistakable paused state (banner + desaturated live indicators), not an item inside a dropdown.
- **Live status pill** in the app bar: active runs, queued runs, awaiting-decision count.

---

## 5. Surface-by-surface

### 5.1 Overview — new home

A factory floor, above the fold:

- **Authority posture strip** — 4 `Meter`/stat cells: repositories in scope, automatic vs approval
  operations, agents enabled, global pause state. Clicking any cell deep-links into Authority.
- **Live activity** — currently executing runs with agent, repository, elapsed time, current step,
  and a cancel affordance. Empty state explains which triggers are armed and what would start a run.
- **Throughput** — `TimeseriesChart`: runs started / effects executed / decisions requested over 24h
  and 7d. (Requires `echarts`; see §8.)
- **Needs you** — top 3 inbox items inline with approve/reject, linking through to Inbox.
- **Recent outcomes** — last 10 runs as a compact `Table` with status, duration, effect count.

`Metric` stops being orphaned and becomes the vocabulary of this page.

### 5.2 Inbox — decision triage

Kill the card stack. This is a queue an operator works down, so build it like one.

- **Split pane**: filterable list left, full decision detail right. One-item list collapses to detail.
- **Keyboard-first**: `j`/`k` move, `a` approve, `r` reject, `e` dismiss, `⏎` open the run.
  Shortcuts are shown, not hidden.
- **Exact-effect approval is the centrepiece.** For an effect awaiting approval, render the precise
  requested operation: operation kind in mono, target resource, and the literal diff/body in
  `CodeBlock`. The approve button reads the operation, e.g. *"Approve `issue.comment.create` on
  `owner/repo#42`"* — never a generic "Approve".
- **Provenance rail**: which agent, which revision (immutable, linked), which trigger event, which
  policy made this an approval rather than an automatic action. Reinforces that the text in the issue
  did not grant this.
- Grouping by priority with urgent pinned; `Pagination` for depth.

### 5.3 Runs — the flagship, built from scratch

**`/runs`** — compact full-row native links with aligned columns for status, agent + revision,
repository, trigger, duration, step count, effect count, and cost. Filters cover status, agent,
repository, and date; native links preserve new-tab and context-menu behavior.

**`/runs/:id`** — the surface that makes the product feel real. Four regions:

1. **Header** — status, agent + pinned revision, trigger event, harness id/version, duration,
   model cost, cancel action. `Breadcrumbs` back to the agent.
2. **Execution graph** — `Flow.Diagram` (verified: compound `Flow.Node` / `Flow.Anchor`, pannable
   canvas, horizontal or vertical). Render tasks as nodes using `parent_task_id` for nesting and
   `parallel_group` for fan-out, so concurrent work is *seen* as concurrent. Node status colour maps
   to the status token scale. Selecting a node filters region 3.
3. **Step timeline** — ordered steps with kind, attempts (`attempt_count`/`max_attempts` surfaced as
   a retry badge), duration, and a `Collapsible` evidence panel per step holding redacted
   input/output in `CodeBlock`. Waits and interruptions render as distinct blocking states, not
   failures.
4. **Effects & receipts** — every proposed effect with its policy mode, decision, decision time,
   execution time, and receipt. Receipts get a copyable `ClipboardText` identifier. This is the
   "traces explain, receipts prove" distinction made visual.

`Tabs` separate Graph / Steps / Effects / Usage on narrow viewports.

### 5.4 Agents

**`/agents`** — catalog, not a card grid. Each row shows lifecycle as a **gate rail**: a 4-segment
indicator for Draft → Published → Activated → Enabled with the closed gates dimmed. An operator sees
instantly that an agent is published but not enabled — today that requires reading two badges and
knowing the model.

**`/agents/:id`** — identity, the gate rail as primary control (each gate is the button that opens
it, with the consequence stated), immutable revision history with `sourceHash` in mono and a
**diff between revisions**, the compiled capability manifest, and recent runs for this agent.

**`/agents/:id/edit`** — the authoring moment. Three columns on wide screens:

- **Source** — `AGENT.md` in a proper editor treatment: mono, line numbers, generous height.
  A textarea is acceptable for v1; do not add a heavyweight editor dependency yet.
- **Compiled manifest** — live, as the source changes: resolved triggers, resolved repository IDs
  (showing `this` → immutable ID), and requested capabilities grouped Observation / Workspace /
  Effects, each effect annotated with the policy mode that will govern it.
- **Gate rail** — Validate → Simulate → Publish paused, as a vertical staged rail where each stage
  unlocks the next and states the boundary in plain language ("Publishing creates an immutable paused
  revision. It does not activate or enable anything."). Diagnostics attach to the stage that produced
  them, with `path` in mono.

The rule "instructions cannot grant authority" should be visible here as an explicit, permanent note
adjacent to the capability list — not buried in a page description.

### 5.5 Authority — Repositories + Policies merged

One page answering one question. `Tabs`:

- **Scope** — repositories with active/paused switches, per-repository pause as an immediate control,
  default branch, and sync. `DeleteResource` for removal.
- **Operations** — replace 30 stacked `.policy-row`s with a **policy matrix**: operation kinds as
  rows grouped by resource (Issues / Pull requests / Discussions / Releases / Checks), mode as a
  3-state segmented control (Disabled / Approval / Automatic). Group-level bulk set. A persistent
  diff-aware save bar reporting *"3 operations will change; 1 becomes automatic"* — because
  escalation to automatic deserves friction.
- **Ceiling** — the instance-wide authority ceiling and what it overrides.

`operationMetadata` in `lib/types.ts` already holds the names and descriptions; it becomes this
page's content source.

### 5.6 Audit — replaces History

Reframed from "a timeline of stuff" to "the evidence store". Filter by actor / kind / date, mono
identifiers throughout, each entry linking to its run and receipt. Chronology stays, but each row
asserts what is *proven* versus what is merely *traced*.

### 5.7 Settings

Keep the deployment-health list; it is the strongest thing in the current UI. Add: instance identity,
Connect status with the trust boundary drawn explicitly, model/harness configuration, runtime limits.
Move Appearance out of a full-width panel into a compact section — it is not the most important thing
on this page, and currently it visually dominates.

### 5.8 Sign-in and setup

Sign-in: **keep the animated ASCII garden**. It is hand-built, seeded, parallaxed, pointer-reactive
and reduced-motion aware, and it is the single strongest piece of personality the product has. Keep
the single focused card, security note, and slower conic-gradient border. Cloudflare attribution is
one quiet text line; do not add a logo banner.

The garden owns its styling in `features/auth/ascii-garden.css`, colocated with the component, so it
loads only on this route and stays deletable in one move. Its foliage derives from the Kumo success
token and deliberately does *not* follow the brand token, keeping foliage and product identity separate.

Setup: keep the two-step wizard. Reframe profile selection so each profile *shows the policy matrix
it produces* rather than three abstract chips — the operator is choosing an authority posture and
should see it.

---

## 6. Design-system contract

Non-negotiable, and enforced in review:

1. **Kumo semantic tokens only.** `bg-kumo-base`, `text-kumo-subtle`, `border-kumo-hairline`,
   `bg-kumo-brand`. No raw hex, no raw Tailwind palette colours in product code.
2. **`data-mode` is Kumo's, not ours.** Kumo owns the scheme switch: `kumo-binding.css` maps
   `[data-mode="dark"]` to `color-scheme: dark`, and `theme-kumo.css` redefines every token under that
   same selector. So `theme.tsx` setting `documentElement.dataset.mode` and the `index.html` bootstrap
   are **correct and must be preserved**. What gets deleted is the app *redefining colours* inside that
   scope, plus the redundant `color-scheme` declarations in `styles.css`. No `dark:` variants either.
3. **Delete the `--gd-*` layer.** Components reference Kumo tokens directly, so the token a developer
   or agent reads in the code is the token that ships.
4. **Tailwind utilities for layout and spacing; `styles.css` only for true globals** — resets, font
   faces, focus ring, skip link, keyframes. Target: **678 → under 100 lines**.
5. **Kumo first.** Before writing a component, check the registry. Nothing hand-rolled that Kumo
   provides.
6. **Brand colour lives in exactly one file.** `ui/accents.css` and nowhere else (§6.1).

Rules 1–4 and 6 are enforced by `scripts/check-ui-conventions.mjs`, which runs in `pnpm check`.
They are not review conventions; they fail the build.

### 6.1 Brand accent

Kumo ships `--color-kumo-brand` as **blue** (`oklch(0.5772 0.2324 260)`). Gardener instead defines
one luminous system green in `ui/accents.css`, the only file permitted to contain a colour value.
There is no selectable alternate accent or first-paint accent state.

The two brand roles are intentionally different:

| Token | Utility | Use |
| --- | --- | --- |
| `--color-kumo-brand` | `bg-kumo-brand` | Deeper green fill carrying Kumo's white labels. |
| `--text-color-kumo-brand` | `text-kumo-brand` | Accessible canvas text; luminous green in dark mode. |
| `--color-gardener-accent-display` | Arbitrary semantic utility | Vibrant brand marks and washes. |
| `--color-gardener-surface` | Arbitrary semantic utility | Material panels derived from Kumo neutrals. |

| Role | Light | Dark |
| --- | --- | --- |
| Action fill | `oklch(0.5411 0.1403 147.64)` | `oklch(0.5411 0.1403 147.64)` |
| Canvas accent | `oklch(0.5411 0.1403 147.64)` | `oklch(0.7556 0.2082 146.98)` |
| Display green | `oklch(0.7303 0.1944 147.44)` | `oklch(0.7556 0.2082 146.98)` |

Every canvas text value clears 4.5:1 against its canvas. The action fill clears 3:1 against each
canvas and 4.5:1 against Kumo's white primary-button label. `ui/accents.test.ts` parses the actual
stylesheet and measures these guarantees, so a colour edit that breaks contrast cannot ship.

### Mapping: hand-rolled → Kumo

| Current bespoke CSS/component | Replace with |
| --- | --- |
| `.data-table`, `.mobile-data-list`, `.mobile-data-card` | `Table` + `sticky`, `Pagination` |
| `.metric`, `.metric-grid` | `Grid` variant `4up` + `Surface` + `Meter` |
| `.surface`, `.section-header`, `.page-header` | `Surface`, `LayerCard`, shared `PageHeader` |
| `.policy-segmented`, `.policy-segment` | `Tabs` variant `segmented`, or `Radio.Group` |
| `.theme-picker`, `.theme-option` | `Radio.Group` with `Field` |
| `.profile-grid`, `.profile-card` | `Radio.Group` + `Surface` |
| `.loading-state` spinner everywhere | `SkeletonLine` for content, `Loader` only for actions |
| `.inline-error`, `.error-state` | `Banner` variants |
| `.confirm-dialog` bespoke padding/`!important` | `Dialog` sizes, `DeleteResource` for destructive |
| `.agent-source-readonly`, `.proposal-item pre` | `Code` / `CodeBlock` |
| `.history-timeline` | `Table` or purpose-built timeline on Kumo tokens |
| `.definition-list`, `.definition-grid` | `Grid` + `Text` variants |
| `.setup-progress` | `Tabs` or a small shared `GateRail` |
| Manual `sentenceCase` headings | `Text` variants `heading1`–`heading3`, `body`, `mono` |

Kumo components currently unused that this plan adopts: `Table`, `Tabs`, `Grid`/`GridItem`,
`CommandPalette`, `Flow`, `Meter`, `Collapsible`, `Code`/`CodeBlock`, `ClipboardText`, `Breadcrumbs`,
`Toolbar`, `Pagination`, `SkeletonLine`, `RefreshButton`, `DeleteResource`, `Text`, `Field`, `Switch`,
`Combobox`, `DateRangePicker`, and `TimeseriesChart`.

### Density and scale

Two densities, chosen per surface rather than globally:

- **Instrument** (Runs, Audit, Authority matrix, tables): 13px base, 32px rows, tight gutters.
- **Decision** (Inbox detail, Agent editor, publishing, Setup): 14px base, generous spacing, one
  unmistakable primary action per view.

---

## 7. Code architecture for agent legibility

The redesign is worthless if the next agent cannot extend it. Restructure so that adding a surface is
a mechanical, one-pattern operation.

```
apps/gardener/ui/
  AGENTS.md                 # rules for agents working in this directory (new)
  app.tsx
  main.tsx
  styles.css                # globals only, <100 lines
  routes.ts                 # single source of truth: route + nav + icon + palette entry (new)
  actions.ts                # guarded action registry, drives ⌘K and confirmations (new)
  theme.tsx                 # preference only, no colour overrides
  primitives/               # the ONLY place Kumo is imported from (new)
    index.ts                # curated re-export surface
    page-header.tsx
    status-badge.tsx
    gate-rail.tsx           # shared lifecycle/gate visual
    stat.tsx
    skeletons.tsx
  features/
    overview/   { overview-page.tsx, components/, hooks.ts }
    inbox/      { inbox-page.tsx, components/, hooks.ts }
    runs/       { runs-page.tsx, run-detail-page.tsx, components/run-graph.tsx, ... }
    agents/     { agents-page.tsx, agent-detail-page.tsx, agent-editor-page.tsx, ... }
    authority/  { authority-page.tsx, components/policy-matrix.tsx, ... }
    audit/      { audit-page.tsx, ... }
    settings/   { settings-page.tsx, ... }
  lib/          { api.ts, types.ts, format.ts, query-keys.ts }
```

Rules to encode in `ui/AGENTS.md`:

1. **Max 120 characters per line. One JSX element per line when the element has more than two props.**
   This alone makes the codebase patchable. Current maximum is 1,622.
2. **One exported component per file**, named after the file.
3. **Import Kumo only through `primitives/index.ts`.** One place to audit, one place to swap.
4. **Kumo semantic tokens only**; the token list lives in `docs/design-system.md`.
5. **New surface = one entry in `routes.ts`** + one folder under `features/`. Nav, breadcrumbs, and
   palette pick it up automatically. No touching the shell.
6. **Every surface implements four states**: loading (skeleton), empty (explains what would appear),
   error (`Banner` + retry), loaded.
7. **Query keys come from `lib/query-keys.ts`.** No inline string arrays.
8. Reference `node_modules/@cloudflare/kumo/ai/USAGE.md` and `ai/component-registry.md` before
   building any component. Kumo ships a 300KB machine-readable registry specifically for this.

Also worth adding: `docs/design-system.md` recording tokens, density scale, status semantics, and the
mapping table above, so design decisions survive without me or the original author in the loop.

---

## 8. Dependency decisions

| Need | Decision |
| --- | --- |
| `echarts` | **Adopted.** Exact pin in `apps/gardener/package.json` plus a `minimumReleaseAgeExclude` entry per the repo's version policy. Imported tree-shaken (core + only the used chart/renderer modules) so the client bundle stays small, and passed explicitly to Kumo's `Chart`/`TimeseriesChart` via the required `echarts` prop. |
| Code editor | **None.** Styled `textarea` for `AGENT.md` in v1. CodeMirror/Monaco is a large dependency for a markdown-with-frontmatter file; revisit only if authoring proves painful. |
| Graph layout lib | **None.** Kumo `Flow` is verified sufficient for the run DAG. |
| Everything else | Already in `package.json`. The redesign is mostly *deletion plus using what is installed*. |

---

## 9. Phased plan

Each phase is independently shippable and leaves the app working.

**Phase 0 — Foundation (no visual change intended). DONE.**
Deleted the `--gd-*` layer and the `[data-mode="dark"]` colour overrides. Moved to Kumo tokens and
Tailwind utilities. Reformatted every file to the 120-char rule. Created `primitives/`, `shell/`,
`providers/`, `features/`, `routes.ts`, `lib/query-keys.ts`, `ui/AGENTS.md`, `docs/design-system.md`.
Deleted the 30 dead selectors, `components/ui.tsx`, and the whole `pages/` tree. Added the brand
accent layer (§6.1) with a contrast test, and kept the ASCII garden — moved to `features/auth/`
with a colocated stylesheet.

Measured outcome:

| Metric | Before | After |
| --- | --- | --- |
| `styles.css` lines | 678 | 99 |
| `styles.css` class selectors | 185 (30 dead) | 1 |
| Hardcoded hex in CSS | 44 | 0 |
| `!important` in CSS | 29 | 4 (reduced-motion only) |
| `--gd-*` alias tokens | 30 | 0 |
| Dark colour-override blocks | 3 | 0 |
| Longest source line | 1,622 chars | 119 chars |
| Lines over 120 chars | 184 | 0 |
| Files importing Kumo directly | 12 | 0 (all via `primitives/`) |
| Total UI code volume | 167.6 kB | 156.7 kB |

The rules are enforced mechanically by `scripts/check-ui-conventions.mjs`, wired into `pnpm check`,
so later phases cannot silently regress them. A line may opt out of the colour rule only with a
`design-system-exempt: <reason>` comment; there is currently exactly one (the `theme-color` meta
tag, which browser chrome cannot read from a CSS custom property).

**Phase 1 — Shell and identity. DONE.**
Gardener uses one luminous system green (§6.1), and the sidebar mark follows it. The desktop
sidebar collapses to Kumo's 57px icon rail, retains automatic tooltips, and uses one stable footer
control with a visible expanded label. Its local state persists; mobile remains off-canvas. The
persistent shell omits vendor attribution, while sign-in retains one quiet deployment line. The
app-bar status pill
and global kill switch live in `AutomationMenu`. `⌘K`
palette wired to `ui/actions.ts`, with a visible trigger in the app bar so the shortcut is
discoverable. Mono is applied as the machine layer across every surface.

Nav groups are still the three from the old IA (Operate, Authority, System) rather than the two
proposed in §4. Overview, Inbox, Runs and Agents sit under Operate, which is a reasonable shape;
collapsing Repositories + Policies into a single `/authority` surface, and renaming History to
Audit, remain open.

**Phase 2 — Runs (flagship). DONE.**
`gardenerApi.runs` / `gardenerApi.run`, `/runs` with status filtering in compact linked rows, and
`/runs/:id` with the task graph, step timeline (retries surfaced explicitly) and the effects table
carrying each effect's admitting policy mode plus a copyable receipt.

The task graph is an **indented tree, not `Flow`**. At this density, parentage and `parallel_group`
read more clearly as nesting than as a node diagram, and it costs no layout dependency. Revisit
only if real runs turn out to be wide rather than deep.

**Phase 6 (partial) — Overview.**
`/` is now the home surface: a drill-down stat strip, recent runs, and a "needs attention" panel
driven by real conditions. It reads entirely from `/api/state`, which already returns the last 50
runs, so no new endpoint was needed. Charts (`echarts`) are still outstanding.

**Phase 3 — Inbox triage.**
Split pane, keyboard shortcuts, exact-effect approval with real diffs, provenance rail.

**Phase 4 — Agents.**
Gate rail component, catalog, detail with revision diff, three-column editor with live compiled
manifest.

**Phase 5 — Authority + Audit.**
Merge Repositories and Policies; build the policy matrix with the escalation-aware save bar. Rebuild
Audit with filters and receipt links.

**Phase 6 — Overview.**
Ships last because it aggregates everything the earlier phases expose. Charts here or deferred per §8.

**Phase 7 — Polish and gates.**
Skeletons everywhere, motion pass with `prefers-reduced-motion`, responsive audit at 360/768/1280/1920,
keyboard traversal of every surface, Axe serious/critical clean, light and dark verified per surface,
then add a customer-owned Gateway onboarding smoke that covers the new routes.

### Kill list

- ~~`ui/components/ascii-garden.tsx` + its test~~ — **reversed.** This was the wrong call: it
  proposed deleting hand-crafted work to satisfy a tidiness rule. The garden is kept, moved to
  `features/auth/`, and given a colocated stylesheet and a restored test.
- 30 dead CSS selectors, including the never-built run-detail styling
- The entire `--gd-*` token layer (30 tokens) and all 3 dark-mode override blocks
- All 29 `!important` declarations
- `.data-table` + `.mobile-data-list` duplication → one `Table`
- `.automation-menu` as the home of global pause → promoted to the app bar
- `History` as a concept → `Audit`
- `Repositories` and `Policies` as separate pages → `Authority`

---

## 10. Definition of done

1. `styles.css` under 100 lines; zero hardcoded colours; zero `!important`; zero `dark:`/`data-mode`
   colour overrides in product code.
2. No source line over 120 characters anywhere in `ui/`.
3. Every route in `routes.ts` renders loading, empty, error, and loaded states.
4. A run's nested parallel tasks, retries, waits, effects, and receipts are all inspectable from
   `/runs/:id`.
5. Every gate in draft → publish → activate → enable is visible, labelled with its consequence, and
   reachable by keyboard.
6. Every approval action names the exact operation and target it authorises.
7. `⌘K` reaches every surface and every guarded action.
8. Axe serious/critical clean on all surfaces, light and dark, at 360px and 1280px.
9. `pnpm check` passes, including `typecheck` for both tsconfigs and the onboarding smoke.
10. A coding agent can add a new surface by editing `routes.ts` and adding one folder, without
    touching the shell or the stylesheet.
