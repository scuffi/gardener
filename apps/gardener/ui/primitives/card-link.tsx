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
        "relative isolate block min-w-0 overflow-hidden rounded-lg",
        "bg-(--color-gardener-surface) p-4 no-underline",
        "before:pointer-events-none before:absolute before:inset-0 before:rounded-[inherit]",
        "before:bg-(--color-gardener-accent-wash) before:opacity-0 before:transition-opacity before:duration-300",
        "before:ease-[cubic-bezier(0.22,1,0.36,1)] hover:before:opacity-100",
        "focus-visible:before:opacity-100 motion-reduce:before:transition-none",
        "!text-kumo-default hover:!text-kumo-default transition-none!",
        className,
      )}
    >
      {children}
    </LayerCard>
  );
}
