import type { Icon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { cn } from "./kumo";

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
}: {
  label: string;
  value: ReactNode;
  detail?: string;
  tone?: StatTone;
  icon?: Icon;
}) {
  const colors = accent[tone];
  return (
    <article
      className={cn(
        "min-w-0 rounded-lg border border-kumo-hairline bg-kumo-base p-4",
        "min-h-[104px] transition-colors hover:border-kumo-line",
      )}
    >
      <div className="flex items-center gap-2">
        {IconComponent ? (
          <span className={cn("grid size-7 place-items-center rounded-md", colors.icon)}>
            <IconComponent size={16} aria-hidden="true" />
          </span>
        ) : null}
        <p className="text-xs font-medium text-kumo-subtle">{label}</p>
      </div>
      <strong className={cn("mt-3 block text-2xl leading-none font-semibold", colors.value)}>
        {value}
      </strong>
      {detail ? <span className="mt-1.5 block text-xs text-kumo-subtle">{detail}</span> : null}
    </article>
  );
}
