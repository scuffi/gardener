import type { ReactNode } from "react";
import { cn, LayerCard, Link } from "./kumo";

/** A full-card navigation target with a restrained, slow hover treatment. */
export function CardLink({
  href,
  label,
  children,
  className,
}: {
  href: string;
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <LayerCard
      render={<Link href={href} variant="plain" aria-label={label} />}
      className={cn(
        "group block min-w-0 overflow-hidden rounded-lg p-4 text-kumo-default no-underline",
        "transition-[border-color,box-shadow,transform] duration-300",
        "ease-[cubic-bezier(0.22,1,0.36,1)] hover:-translate-y-px hover:border-kumo-line",
        "hover:shadow-sm focus-visible:-translate-y-px focus-visible:border-kumo-line",
        className,
      )}
    >
      {children}
    </LayerCard>
  );
}
