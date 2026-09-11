import { MoonIcon, PaletteIcon, PauseIcon, PlayIcon, SunIcon, type Icon } from "@phosphor-icons/react";
import type { AppState } from "./lib/types";
import { routes } from "./routes";

/**
 * Everything the command palette can do.
 *
 * Navigation entries are derived from `routes.ts` so a new surface appears in the palette with no
 * extra work. Commands are declared here because they act on app state rather than navigate.
 *
 * See `ui/AGENTS.md` before adding an entry.
 */

export interface Action {
  id: string;
  title: string;
  description?: string;
  icon?: Icon;
  /** Extra words matched by search that are not shown in the label. */
  keywords?: string;
  /** Exactly one of these is set. */
  href?: string;
  run?: () => void;
}

export interface ActionGroup {
  id: string;
  label: string;
  items: Action[];
}

interface CommandContext {
  state: AppState | null;
  resolvedTheme: "light" | "dark";
  setPreference: (preference: "light" | "dark") => void;
  accent: "orange" | "green";
  setAccent: (accent: "orange" | "green") => void;
  setPaused: (paused: boolean) => void;
}

/** Navigable surfaces, excluding detail routes that need an id. */
function navigationActions(): Action[] {
  return routes
    .filter((route) => !route.path.includes(":"))
    .map((route) => ({
      id: `go:${route.id}`,
      title: route.label,
      description: route.description,
      icon: route.icon,
      href: route.path,
    }));
}

function commandActions(context: CommandContext): Action[] {
  const paused = Boolean(context.state?.globalPaused);
  const dark = context.resolvedTheme === "dark";
  const green = context.accent === "green";

  return [
    {
      id: "cmd:pause",
      title: paused ? "Resume Gardener globally" : "Pause Gardener globally",
      description: paused
        ? "Allow new work to start again"
        : "Stop new work; in-flight operations may finish",
      icon: paused ? PlayIcon : PauseIcon,
      keywords: "kill switch stop start automation",
      run: () => context.setPaused(!paused),
    },
    {
      id: "cmd:theme",
      title: `Switch to ${dark ? "light" : "dark"} theme`,
      icon: dark ? SunIcon : MoonIcon,
      keywords: "appearance colour color scheme",
      run: () => context.setPreference(dark ? "light" : "dark"),
    },
    {
      id: "cmd:accent",
      title: `Use ${green ? "Cloudflare orange" : "Gardener green"} accent`,
      icon: PaletteIcon,
      keywords: "brand colour color accent",
      run: () => context.setAccent(green ? "orange" : "green"),
    },
  ];
}

export function actionGroups(context: CommandContext): ActionGroup[] {
  return [
    { id: "navigate", label: "Go to", items: navigationActions() },
    { id: "commands", label: "Commands", items: commandActions(context) },
  ];
}

/** Case-insensitive match across title, description and keywords. */
export function filterActionGroups(groups: ActionGroup[], query: string): ActionGroup[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return groups;
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) =>
        `${item.title} ${item.description ?? ""} ${item.keywords ?? ""}`
          .toLowerCase()
          .includes(needle),
      ),
    }))
    .filter((group) => group.items.length > 0);
}
