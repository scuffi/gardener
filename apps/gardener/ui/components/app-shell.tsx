import {
  CheckSquareIcon, DatabaseIcon, GearIcon, GitBranchIcon, HouseIcon, ListChecksIcon,
  LockSimpleIcon, ShieldCheckIcon, PlantIcon, XIcon, ListIcon,
  type Icon,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useGardener } from "../app-context";
import { AccountMenu } from "./account-menu";
import { AutomationMenu } from "./automation-menu";
import { ThemeToggle } from "../theme";

interface NavItem { to: string; label: string; icon: Icon; badge?: number }
interface NavGroup { label: string; items: NavItem[] }

export function AppShell({ children }: { children: ReactNode }) {
  const { state, authenticated } = useGardener();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const setupComplete = Boolean(state?.setup.completed);
  const approvals = state?.approvals.length ?? 0;

  useEffect(() => setMobileOpen(false), [location.pathname]);
  useEffect(() => {
    if (!mobileOpen) return;
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileOpen(false);
        requestAnimationFrame(() => menuButtonRef.current?.focus());
        return;
      }
      if (event.key !== "Tab" || !sidebarRef.current) return;
      const focusable = [...sidebarRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')]
        .filter((element) => element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [mobileOpen]);

  const closeMobileNavigation = () => {
    setMobileOpen(false);
    requestAnimationFrame(() => menuButtonRef.current?.focus());
  };

  const groups: NavGroup[] = [
    { label: "Workspace", items: [
      { to: "/overview", label: "Overview", icon: HouseIcon },
      { to: "/repositories", label: "Repositories", icon: GitBranchIcon },
    ] },
    { label: "Automation", items: [
      { to: "/workflows", label: "Workflows", icon: ListChecksIcon },
      { to: "/policies", label: "Policies", icon: ShieldCheckIcon },
    ] },
    { label: "Monitor", items: [
      { to: "/runs", label: "Runs", icon: DatabaseIcon },
      { to: "/approvals", label: "Approvals", icon: CheckSquareIcon, badge: approvals },
    ] },
    { label: "System", items: [{ to: "/settings", label: "Settings", icon: GearIcon }] },
  ];

  const navigation = <>
    {groups.map((group) => <div className="nav-group" key={group.label}>
      <p className="nav-group__label">{group.label}</p>
      <div className="nav-group__items">
        {group.items.map((item) => {
          const locked = !setupComplete && item.to !== "/overview";
          if (locked) return <div className="nav-item nav-item--locked" key={item.to} aria-disabled="true">
            <item.icon size={17} aria-hidden="true" /><span>{item.label}</span><LockSimpleIcon size={12} aria-hidden="true" />
          </div>;
          return <NavLink key={item.to} to={item.to} className={({ isActive }) => `nav-item${isActive ? " nav-item--active" : ""}`}>
            <item.icon size={17} aria-hidden="true" /><span>{item.label}</span>
            {item.badge ? <span className="nav-badge" aria-label={`${item.badge} pending`}>{item.badge}</span> : null}
          </NavLink>;
        })}
      </div>
    </div>)}
  </>;

  return <div className="app-shell" data-route={location.pathname}>
    <a className="skip-link" href="#main-content">Skip to content</a>
    <div ref={sidebarRef} id="mobile-navigation" className={`sidebar${mobileOpen ? " sidebar--open" : ""}`} aria-label="Application navigation" role={mobileOpen ? "dialog" : "complementary"} aria-modal={mobileOpen || undefined}>
      <div className="sidebar__header">
        <NavLink to="/overview" className="brand" aria-label="Gardener overview">
          <span className="brand__mark"><PlantIcon size={20} weight="bold" aria-hidden="true" /></span>
          <span><strong>Gardener</strong><small>Repository automation</small></span>
        </NavLink>
        <button ref={closeButtonRef} className="sidebar__close" onClick={closeMobileNavigation} aria-label="Close navigation"><XIcon size={20} /></button>
      </div>
      <nav className="sidebar__nav">{navigation}</nav>
      <div className="sidebar__footer">
        {authenticated ? <AccountMenu /> : null}
      </div>
    </div>
    {mobileOpen ? <button className="sidebar-backdrop" tabIndex={-1} aria-label="Close navigation" onClick={closeMobileNavigation} /> : null}

    <div className="app-frame" inert={mobileOpen || undefined}>
      <header className="app-bar">
        <button ref={menuButtonRef} className="mobile-menu" onClick={() => setMobileOpen(true)} aria-label="Open navigation" aria-expanded={mobileOpen} aria-controls="mobile-navigation"><ListIcon size={21} /></button>
        <div className="app-bar__context">
          <PlantIcon size={18} weight="bold" aria-hidden="true" />
          <span>{setupComplete ? "Gardener" : "Setup"}</span>
        </div>
        <div className="app-bar__actions">
          <ThemeToggle />
          {setupComplete ? <AutomationMenu /> : null}
        </div>
      </header>
      <main id="main-content" className="main-content">{children}</main>
    </div>

  </div>;
}
