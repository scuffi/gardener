import type { ReactNode } from "react";
import { cn, LayerCard } from "./kumo";

/**
 * A content panel. Wraps Kumo `LayerCard` (Kumo's `Surface` is deprecated in favour of it).
 *
 * Use `padded={false}` when the panel contains a `PanelHeader`, a table, or any full-bleed list
 * that manages its own padding.
 */
export function Panel({
  children,
  className,
  padded = true,
  as = "section",
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
  as?: "section" | "div" | "article" | "aside";
}) {
  const Element = as;
  return (
    <LayerCard
      render={<Element />}
      className={cn(
        "min-w-0 overflow-hidden rounded-lg bg-(--color-gardener-surface)",
        padded && "p-4",
        className,
      )}
    >
      {children}
    </LayerCard>
  );
}

/** Header row inside a `Panel`. Sits on the elevated surface with a hairline beneath. */
export function PanelHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-5 border-b border-kumo-hairline",
        "bg-(--color-gardener-surface-strong) px-4 py-3.5",
      )}
    >
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold text-kumo-strong">{title}</h2>
        {description ? <p className="mt-0.5 text-sm text-kumo-default">{description}</p> : null}
      </div>
      {actions ? <div className="flex-none">{actions}</div> : null}
    </div>
  );
}
