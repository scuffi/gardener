import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Empty } from "@cloudflare/kumo/components/empty";
import type { Icon } from "@phosphor-icons/react";
import { ArrowClockwiseIcon, ArrowRightIcon, CheckCircleIcon, CpuIcon, GithubLogoIcon, ShieldCheckIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { Fragment, useEffect, useRef, type ReactNode } from "react";
import { sentenceCase } from "../lib/format";

export function PageHeader({ title, description, eyebrow, actions }: { title: string; description?: string; eyebrow?: string; actions?: ReactNode }) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => titleRef.current?.focus({ preventScroll: true }), []);
  return <header className="page-header">
    <div className="page-header__copy">
      {eyebrow ? <p className="overline">{eyebrow}</p> : null}
      <h1 ref={titleRef} tabIndex={-1}>{title}</h1>
      {description ? <p>{description}</p> : null}
    </div>
    {actions ? <div className="page-header__actions">{actions}</div> : null}
  </header>;
}

export function SectionHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return <div className="section-header">
    <div><h2>{title}</h2>{description ? <p>{description}</p> : null}</div>
    {actions ? <div className="section-header__actions">{actions}</div> : null}
  </div>;
}

export function Surface({ children, className = "", padded = true }: { children: ReactNode; className?: string; padded?: boolean }) {
  return <section className={`surface${padded ? " surface--padded" : ""}${className ? ` ${className}` : ""}`}>{children}</section>;
}

export type StatusTone = "success" | "warning" | "error" | "info" | "neutral";
export function StatusBadge({ children, tone = "neutral" }: { children: ReactNode; tone?: StatusTone }) {
  const variant = tone === "neutral" ? "secondary" : tone;
  return <Badge variant={variant} appearance={tone === "neutral" ? "filled" : "dot"}>{children}</Badge>;
}

export function AutomationTrace({ variant = "execution", compact = false }: { variant?: "execution" | "workflow"; compact?: boolean }) {
  const items = variant === "execution"
    ? [{ label: "Event", icon: GithubLogoIcon }, { label: "Policy", icon: ShieldCheckIcon }, { label: "Action", icon: CheckCircleIcon }]
    : [{ label: "Event", icon: GithubLogoIcon }, { label: "Workers AI", icon: CpuIcon }, { label: "Policy", icon: ShieldCheckIcon }];
  return <div className={`automation-path${compact ? " automation-path--compact" : ""}`} aria-label={`Automation path: ${items.map((item) => item.label).join(", ")}`}>
    {items.map((item, index) => {
      const ItemIcon = item.icon;
      return <Fragment key={item.label}><span className="automation-path__step"><ItemIcon size={compact ? 13 : 15} aria-hidden="true" />{item.label}</span>{index < items.length - 1 ? <ArrowRightIcon className="automation-path__arrow" size={compact ? 11 : 13} aria-hidden="true" /> : null}</Fragment>;
    })}
  </div>;
}

export function RunStatus({ status }: { status: string }) {
  const tone: StatusTone = ["completed", "executed"].includes(status) ? "success"
    : ["failed", "completed_with_errors"].includes(status) ? "error"
      : ["queued", "pending", "executing"].includes(status) ? "warning" : "neutral";
  return <StatusBadge tone={tone}>{sentenceCase(status)}</StatusBadge>;
}

export function EmptyState({ icon: IconComponent, title, description, action, compact = false }: { icon?: Icon; title: string; description: string; action?: ReactNode; compact?: boolean }) {
  return <Empty
    size={compact ? "sm" : "base"}
    icon={IconComponent ? <IconComponent size={compact ? 32 : 40} aria-hidden="true" /> : undefined}
    title={title}
    description={description}
    contents={action}
    className="empty-state"
  />;
}

export function LoadingState({ label = "Loading" }: { label?: string }) {
  return <div className="loading-state" role="status" aria-live="polite">
    <span className="spinner" aria-hidden="true" />
    <span>{label}</span>
  </div>;
}

export function ErrorState({ title = "Unable to load this page", message, onRetry }: { title?: string; message: string; onRetry?: () => void }) {
  return <Surface className="error-state">
    <WarningCircleIcon size={24} aria-hidden="true" />
    <div><h2>{title}</h2><p>{message}</p></div>
    {onRetry ? <Button variant="secondary" icon={ArrowClockwiseIcon} onClick={onRetry}>Try again</Button> : null}
  </Surface>;
}

export function Metric({ label, value, detail, tone = "default", icon: IconComponent }: { label: string; value: ReactNode; detail?: string; tone?: "default" | "danger" | "warning" | "success" | "info"; icon?: Icon }) {
  return <article className={`metric metric--${tone}`}>
    <div className="metric__top">{IconComponent ? <span className="metric__icon"><IconComponent size={17} aria-hidden="true" /></span> : null}<p>{label}</p></div>
    <strong>{value}</strong>{detail ? <span>{detail}</span> : null}
  </article>;
}
