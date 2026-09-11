import {
  ClockCounterClockwiseIcon,
  GearIcon,
  GitBranchIcon,
  PulseIcon,
  RobotIcon,
  ShieldCheckIcon,
  SquaresFourIcon,
  TrayIcon,
  type Icon,
} from "@phosphor-icons/react";
import type { ComponentType } from "react";
import type { AppState } from "./lib/types";

/**
 * Single source of truth for dashboard navigation.
 *
 * Sidebar groups, the app-bar context label, document titles, and (from phase 1) the command
 * palette are all derived from this file. Adding a surface means adding one entry here plus one
 * folder under `features/` — never editing the shell.
 *
 * See `ui/AGENTS.md` for the full procedure.
 */

export type NavGroupId = "operate" | "authority" | "system";

export interface NavGroup {
  id: NavGroupId;
  label: string;
}

/** Rendered in this order in the sidebar. */
export const navGroups: readonly NavGroup[] = [
  { id: "operate", label: "Operate" },
  { id: "authority", label: "Authority" },
  { id: "system", label: "System" },
];

type PageModule = { default: ComponentType };

export interface RouteDefinition {
  /** Stable identifier, also used as the React key and the palette entry id. */
  id: string;
  /** Primary path. Must be absolute. */
  path: string;
  /** Sidebar and app-bar label. */
  label: string;
  icon: Icon;
  /** Omit to keep the route out of the sidebar (detail and editor routes). */
  group?: NavGroupId;
  /** One-line explanation, used by the command palette. */
  description: string;
  /** Lazy page loader. Must resolve to a component. */
  load: () => Promise<PageModule>;
  /** Additional paths that render the same page (detail, editor, nested views). */
  extraPaths?: readonly string[];
  /** When true, child paths under `path` keep this route marked active. */
  matchPrefix?: boolean;
  /** Optional sidebar count badge. */
  badge?: (state: AppState | null) => number | undefined;
}

export const routes: readonly RouteDefinition[] = [
  {
    id: "overview",
    path: "/",
    label: "Overview",
    icon: SquaresFourIcon,
    group: "operate",
    description: "Fleet health, live work, and what needs a decision",
    load: () =>
      import("./features/overview/overview-page").then((m) => ({ default: m.OverviewPage })),
  },
  {
    id: "inbox",
    path: "/inbox",
    label: "Inbox",
    icon: TrayIcon,
    group: "operate",
    description: "Review decisions, blocked work, failures, and regressions",
    load: () => import("./features/inbox/inbox-page").then((m) => ({ default: m.InboxPage })),
    badge: (state) => state?.inboxCount,
  },
  {
    id: "runs",
    path: "/runs",
    label: "Runs",
    icon: PulseIcon,
    group: "operate",
    description: "Every Agent run, its steps, and the effects it produced",
    load: () => import("./features/runs/runs-page").then((m) => ({ default: m.RunsPage })),
    matchPrefix: true,
  },
  {
    id: "run-detail",
    path: "/runs/:id",
    label: "Run detail",
    icon: PulseIcon,
    description: "Inspect a run's task graph, step timeline, and effect receipts",
    load: () =>
      import("./features/runs/run-detail-page").then((m) => ({ default: m.RunDetailPage })),
  },
  {
    id: "agents",
    path: "/agents",
    label: "Agents",
    icon: RobotIcon,
    group: "operate",
    description: "Author, publish, activate, and enable Agents",
    load: () => import("./features/agents/agents-page").then((m) => ({ default: m.AgentsPage })),
    matchPrefix: true,
  },
  {
    id: "agent-editor",
    path: "/agents/new",
    label: "New Agent",
    icon: RobotIcon,
    description: "Author a new AGENT.md package",
    load: () =>
      import("./features/agents/agent-editor-page").then((m) => ({ default: m.AgentEditorPage })),
    extraPaths: ["/agents/:id/draft"],
  },
  {
    id: "agent-detail",
    path: "/agents/:id",
    label: "Agent detail",
    icon: RobotIcon,
    description: "Inspect an Agent, its revisions, and its capabilities",
    load: () =>
      import("./features/agents/agent-detail-page").then((m) => ({ default: m.AgentDetailPage })),
    extraPaths: ["/agents/:id/revisions/:revision"],
  },
  {
    id: "history",
    path: "/history",
    label: "History",
    icon: ClockCounterClockwiseIcon,
    group: "operate",
    description: "Inspect runs, decisions, revisions, and administrative actions",
    load: () => import("./features/history/history-page").then((m) => ({ default: m.HistoryPage })),
  },
  {
    id: "repositories",
    path: "/repositories",
    label: "Repositories",
    icon: GitBranchIcon,
    group: "authority",
    description: "Choose where Gardener may observe and act",
    load: () =>
      import("./features/repositories/repositories-page").then((m) => ({
        default: m.RepositoriesPage,
      })),
  },
  {
    id: "policies",
    path: "/policies",
    label: "Policies",
    icon: ShieldCheckIcon,
    group: "authority",
    description: "Set which GitHub operations are off, need approval, or run automatically",
    load: () =>
      import("./features/policies/policies-page").then((m) => ({ default: m.PoliciesPage })),
  },
  {
    id: "settings",
    path: "/settings",
    label: "Settings",
    icon: GearIcon,
    group: "system",
    description: "Inspect deployment health, services, and appearance",
    load: () =>
      import("./features/settings/settings-page").then((m) => ({ default: m.SettingsPage })),
  },
];

/** Where the dashboard lands after sign-in and setup. */
export const defaultRoute = "/";

/** Routes that appear in the sidebar, in group order. */
export function navigationGroups(): Array<{ group: NavGroup; items: RouteDefinition[] }> {
  return navGroups
    .map((group) => ({
      group,
      items: routes.filter((route) => route.group === group.id),
    }))
    .filter((entry) => entry.items.length > 0);
}

/** True when `pathname` should mark `route` as the current surface. */
export function isRouteActive(route: RouteDefinition, pathname: string): boolean {
  if (pathname === route.path) return true;
  if (route.matchPrefix && pathname.startsWith(`${route.path}/`)) return true;
  return false;
}

/** The route owning `pathname`, preferring exact matches over prefix matches. */
export function resolveRoute(pathname: string): RouteDefinition | undefined {
  return (
    routes.find((route) => route.path === pathname) ??
    routes.find((route) => route.matchPrefix && pathname.startsWith(`${route.path}/`))
  );
}
