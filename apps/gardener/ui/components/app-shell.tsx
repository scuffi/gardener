import { Sidebar, useSidebar } from "@cloudflare/kumo/components/sidebar";
import { ClockCounterClockwiseIcon, GearIcon, GitBranchIcon, TrayIcon, ListIcon, LockSimpleIcon, PlantIcon, RobotIcon, ShieldCheckIcon, type Icon } from "@phosphor-icons/react";
import { useEffect, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useGardener } from "../app-context";
import { ThemeToggle } from "../theme";
import { AccountMenu } from "./account-menu";
import { AutomationMenu } from "./automation-menu";

interface NavItem { to: string; label: string; icon: Icon; badge?: number | undefined }
interface NavGroup { label: string; items: NavItem[] }
function matches(pathname: string, to: string) { return pathname === to || (to === "/agents" && pathname.startsWith("/agents/")); }
function SidebarRouteSync() { const { pathname } = useLocation(); const { setOpenMobile } = useSidebar(); useEffect(() => setOpenMobile(false), [pathname, setOpenMobile]); return null; }
function GardenerBrand() { const { setOpenMobile } = useSidebar(); return <NavLink to="/inbox" className="brand" aria-label="Gardener inbox" onClick={() => setOpenMobile(false)}><span className="brand__mark"><PlantIcon size={19} weight="bold" aria-hidden="true" /></span><span><strong>Gardener</strong><small>Repository stewardship</small></span></NavLink>; }
function AppNavigation({ groups, setupComplete }: { groups: NavGroup[]; setupComplete: boolean }) {
  const { pathname } = useLocation(); const { setOpenMobile } = useSidebar();
  return <>{groups.map((group) => <Sidebar.Group key={group.label}><Sidebar.GroupLabel>{group.label}</Sidebar.GroupLabel><Sidebar.Menu>{group.items.map((item) => {
    const locked = !setupComplete; const active = !locked && matches(pathname, item.to);
    return <Sidebar.MenuButton key={item.to} icon={item.icon} active={active} disabled={locked} aria-disabled={locked || undefined} tooltip={item.label} className={locked ? "nav-item--locked" : ""} {...(locked ? {} : { href: item.to, "aria-current": active ? "page" as const : undefined })} onClick={() => setOpenMobile(false)}>{item.label}{locked ? <LockSimpleIcon className="nav-item__trailing" size={12} /> : null}{item.badge ? <Sidebar.MenuBadge aria-label={`${item.badge} open items`}>{item.badge}</Sidebar.MenuBadge> : null}</Sidebar.MenuButton>;
  })}</Sidebar.Menu></Sidebar.Group>)}</>;
}

export function AppShell({ children }: { children: ReactNode }) {
  const { state, authenticated } = useGardener(); const { pathname } = useLocation(); const setupComplete = Boolean(state?.setup.completed);
  const groups: NavGroup[] = [
    { label: "Operate", items: [{ to: "/inbox", label: "Inbox", icon: TrayIcon, badge: state?.inboxCount }, { to: "/agents", label: "Agents", icon: RobotIcon }, { to: "/history", label: "History", icon: ClockCounterClockwiseIcon }] },
    { label: "Authority", items: [{ to: "/repositories", label: "Repositories", icon: GitBranchIcon }, { to: "/policies", label: "Policies", icon: ShieldCheckIcon }] },
    { label: "System", items: [{ to: "/settings", label: "Settings", icon: GearIcon }] },
  ];
  const current = groups.flatMap((group) => group.items).find((item) => matches(pathname, item.to)); const ContextIcon = setupComplete ? current?.icon ?? PlantIcon : PlantIcon;
  return <Sidebar.Provider defaultOpen mobileBreakpoint={900} collapsible="offcanvas" className="app-shell"><a className="skip-link" href="#main-content">Skip to content</a><SidebarRouteSync />
    <Sidebar id="mobile-navigation" className="gardener-sidebar" aria-label="Application navigation"><Sidebar.Header className="gardener-sidebar__header"><GardenerBrand /><Sidebar.Close className="gardener-sidebar__close" aria-label="Close navigation" /></Sidebar.Header><Sidebar.Content className="gardener-sidebar__nav"><AppNavigation groups={groups} setupComplete={setupComplete} /></Sidebar.Content><Sidebar.Footer className="gardener-sidebar__footer">{authenticated ? <AccountMenu /> : null}</Sidebar.Footer></Sidebar>
    <div className="app-frame"><header className="app-bar"><Sidebar.Trigger className="mobile-menu" aria-label="Open navigation"><ListIcon size={19} /></Sidebar.Trigger><div className="app-bar__context"><ContextIcon size={17} aria-hidden="true" /><span>{setupComplete ? current?.label ?? "Gardener" : "Setup"}</span></div><div className="app-bar__actions"><ThemeToggle />{setupComplete ? <AutomationMenu /> : null}</div></header><main id="main-content" className="main-content">{children}</main></div>
  </Sidebar.Provider>;
}
