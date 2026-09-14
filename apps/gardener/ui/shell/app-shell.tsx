import { ListIcon, LockSimpleIcon, PlantIcon } from "@phosphor-icons/react";
import { useEffect, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useGardener } from "../app-context";
import { cn, Sidebar, useSidebar } from "../primitives";
import { defaultRoute, isRouteActive, navigationGroups, resolveRoute } from "../routes";
import { ThemeToggle } from "../theme";
import { AccountMenu } from "./account-menu";
import { AutomationMenu } from "./automation-menu";
import { CommandPaletteProvider, CommandPaletteTrigger } from "./command-palette";
import { SkipLink } from "./skip-link";

/** Collapse the mobile drawer whenever the route changes. */
function SidebarRouteSync() {
  const { pathname } = useLocation();
  const { setOpenMobile } = useSidebar();
  useEffect(() => setOpenMobile(false), [pathname, setOpenMobile]);
  return null;
}

function GardenerBrand() {
  const { setOpenMobile } = useSidebar();
  return (
    <NavLink
      to={defaultRoute}
      aria-label="Gardener home"
      onClick={() => setOpenMobile(false)}
      className="flex min-w-0 items-center gap-2.5 text-kumo-strong no-underline"
    >
      <span
        className={cn(
          "relative grid size-7 flex-none place-items-center rounded-md",
          "border border-kumo-hairline bg-kumo-brand/12 text-kumo-brand",
        )}
      >
        <PlantIcon size={19} weight="bold" aria-hidden="true" />
      </span>
      <span className="grid min-w-0 leading-tight">
        <strong className="text-sm font-semibold">Gardener</strong>
        <span className="mt-0.5 text-[11px] text-kumo-subtle">Repository stewardship</span>
      </span>
    </NavLink>
  );
}

/**
 * Sidebar navigation, derived entirely from `routes.ts`.
 *
 * Adding a surface must never require editing this component — see `ui/AGENTS.md`.
 */
function AppNavigation({ setupComplete }: { setupComplete: boolean }) {
  const { pathname } = useLocation();
  const { setOpenMobile } = useSidebar();
  const { state } = useGardener();

  return (
    <>
      {navigationGroups().map(({ group, items }) => (
        <Sidebar.Group key={group.id}>
          <Sidebar.GroupLabel>{group.label}</Sidebar.GroupLabel>
          <Sidebar.Menu>
            {items.map((route) => {
              const locked = !setupComplete;
              const active = !locked && isRouteActive(route, pathname);
              const badge = route.badge?.(state);
              return (
                <Sidebar.MenuButton
                  key={route.id}
                  icon={route.icon}
                  active={active}
                  disabled={locked}
                  aria-disabled={locked || undefined}
                  tooltip={route.label}
                  className={
                    locked
                      ? "cursor-not-allowed opacity-50 max-[900px]:min-h-11"
                      : "text-kumo-default max-[900px]:min-h-11 [&_.truncate]:text-kumo-default"
                  }
                  onClick={() => setOpenMobile(false)}
                  {...(locked
                    ? {}
                    : { href: route.path, "aria-current": active ? ("page" as const) : undefined })}
                >
                  {route.label}
                  {locked ? <LockSimpleIcon className="ml-auto opacity-60" size={12} /> : null}
                  {badge ? (
                    <Sidebar.MenuBadge aria-label={`${badge} open items`}>{badge}</Sidebar.MenuBadge>
                  ) : null}
                </Sidebar.MenuButton>
              );
            })}
          </Sidebar.Menu>
        </Sidebar.Group>
      ))}
    </>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { state, authenticated } = useGardener();
  const { pathname } = useLocation();
  const setupComplete = Boolean(state?.setup.completed);
  const current = resolveRoute(pathname);
  const ContextIcon = setupComplete ? (current?.icon ?? PlantIcon) : PlantIcon;
  const contextLabel = setupComplete ? (current?.label ?? "Gardener") : "Setup";

  useEffect(() => {
    document.title = `${contextLabel} · Gardener`;
  }, [contextLabel]);

  return (
    <CommandPaletteProvider>
      <Sidebar.Provider
        defaultOpen
        mobileBreakpoint={900}
        collapsible="offcanvas"
        className="min-h-svh bg-kumo-canvas"
      >
      <SkipLink />
      <SidebarRouteSync />
      <Sidebar
        id="mobile-navigation"
        aria-label="Application navigation"
        className={cn(
          "[--sidebar-active-bg:var(--color-kumo-tint)] [--sidebar-bg:var(--color-kumo-base)]",
          "min-[901px]:sticky min-[901px]:top-0 min-[901px]:h-svh min-[901px]:self-start",
        )}
      >
        <Sidebar.Header className="h-13 min-h-13 px-3.5">
          <GardenerBrand />
          <Sidebar.Close
            className="ml-auto max-[900px]:flex max-[900px]:size-11 min-[901px]:hidden"
            aria-label="Close navigation"
          />
        </Sidebar.Header>
        <Sidebar.Content>
          <AppNavigation setupComplete={setupComplete} />
        </Sidebar.Content>
        <Sidebar.Footer className="grid! h-auto! overflow-visible gap-1 py-2">
          {authenticated ? <AccountMenu /> : null}
          <p className="px-2 pt-2 pb-1 text-center text-[10px] tracking-wide text-kumo-subtle">
            Cloudflare Workers
          </p>
        </Sidebar.Footer>
      </Sidebar>

      <div className="flex min-h-svh min-w-0 flex-1 flex-col">
        <header
          className={cn(
            "sticky top-0 z-30 flex h-13 items-center justify-between gap-4",
            "border-b border-kumo-line bg-kumo-base px-6 max-sm:px-4",
          )}
        >
          <Sidebar.Trigger
            className="max-[900px]:size-11 min-[901px]:hidden"
            aria-label="Open navigation"
          >
            <ListIcon size={19} />
          </Sidebar.Trigger>
          <div
            className={
              "flex min-w-0 items-center gap-2 text-[13px] font-semibold text-kumo-strong " +
              "max-[480px]:hidden"
            }
          >
            <ContextIcon size={17} aria-hidden="true" className="flex-none text-kumo-subtle" />
            <span className="max-[360px]:hidden">{contextLabel}</span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {setupComplete ? <CommandPaletteTrigger /> : null}
            <ThemeToggle />
            {setupComplete ? <AutomationMenu /> : null}
          </div>
        </header>
        <main
          id="main-content"
          className="mx-auto w-full max-w-[1280px] px-8 pt-7 pb-16 max-sm:px-4"
        >
          {children}
        </main>
      </div>
      </Sidebar.Provider>
    </CommandPaletteProvider>
  );
}
