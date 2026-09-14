import type { Icon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { cn, Link } from "./kumo";

export type StatTone = "default" | "success" | "warning" | "danger" | "info";

const accent: Record<StatTone, { icon: string; value: string }> = {
  default: { icon: "text-kumo-subtle bg-kumo-tint", value: "text-kumo-strong" },
  success: { icon: "text-kumo-success bg-kumo-success/10", value: "text-kumo-strong" },
  info: { icon: "text-kumo-info bg-kumo-info/10", value: "text-kumo-strong" },
  warning: { icon: "text-kumo-warning bg-kumo-warning/10", value: "text-kumo-warning" },
  danger: { icon: "text-kumo-danger bg-kumo-danger/10", value: "text-kumo-danger" },
};

/**
 * A single metric cell, used in Overview and in summary strips.
 *
 * Pass `href` to make the whole cell a link into the surface that explains the number — a metric
 * an operator cannot drill into is decoration.
 */
export function Stat({
  label,
  value,
  detail,
  tone = "default",
  icon: IconComponent,
  href,
}: {
  label: string;
  value: ReactNode;
  detail?: string | undefined;
  tone?: StatTone | undefined;
  icon?: Icon | undefined;
  /** Drill-down target. Makes the whole cell a link. */
  href?: string | undefined;
}) {
  const colors = accent[tone];
  const body = (
    <>
      <div className="flex items-center gap-2">
        {IconComponent ? (
          <span className={cn("grid size-7 place-items-center rounded-md", colors.icon)}>
            <IconComponent size={16} aria-hidden="true" />
          </span>
        ) : null}
        <p className="text-xs font-medium text-kumo-default">{label}</p>
      </div>
      <strong className={cn("mt-3 block text-2xl leading-none font-semibold", colors.value)}>
        {value}
      </strong>
      {detail ? <span className="mt-1.5 block text-xs text-kumo-default">{detail}</span> : null}
    </>
  );

  const shell = cn(
    "block min-w-0 rounded-lg border border-kumo-hairline bg-kumo-base p-4",
    "min-h-[104px] transition-colors",
  );

  if (!href) return <article className={cn(shell, "hover:border-kumo-line")}>{body}</article>;

  return (
    <Link
      href={href}
      variant="plain"
      className={cn(
        shell,
        "grid! content-start text-kumo-default no-underline hover:border-kumo-line hover:bg-kumo-tint",
      )}
    >
      {body}
    </Link>
  );
}
