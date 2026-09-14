/**
 * The dashboard's component surface.
 *
 * Features import everything from here — both curated Kumo components and Gardener's own
 * primitives. Never import `@cloudflare/kumo` inside `features/`; see `ui/AGENTS.md`.
 */

// Curated Kumo re-exports.
export * from "./kumo";

// Gardener primitives.
export { CardLink } from "./card-link";
export { ConfirmDialog } from "./confirm-dialog";
export { Mono, shortHash } from "./mono";
export { PageHeader } from "./page-header";
export { Panel, PanelHeader } from "./panel";
export { CardSkeleton, PageHeaderSkeleton, TableSkeleton } from "./skeletons";
export { Stat, type StatTone } from "./stat";
export { EmptyState, ErrorState, LoadingState } from "./states";
export { RunStatus, StatusBadge, statusTone, type StatusTone } from "./status-badge";
