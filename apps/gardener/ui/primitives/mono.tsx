import { cn } from "./kumo";

/**
 * The machine layer. See `docs/design-system.md` §5.
 *
 * Use for run IDs, source hashes, revision numbers, operation kinds, policy keys, receipts,
 * repository IDs, and diagnostic paths — anything that is an exact identifier rather than prose.
 * The sans/mono split is how an operator tells Gardener's own words apart from literal values.
 */
export function Mono({
  children,
  title,
  truncate = false,
  tone = "subtle",
  className,
}: {
  children: string;
  /**
   * Full value shown on hover when the rendered text is shortened.
   *
   * Explicitly allows `undefined` because `exactOptionalPropertyTypes` is on and callers
   * routinely pass a nullable identifier as `title={value ?? undefined}`.
   */
  title?: string | undefined;
  truncate?: boolean | undefined;
  tone?: "subtle" | "default" | "strong" | undefined;
  className?: string | undefined;
}) {
  const color =
    tone === "strong"
      ? "text-kumo-strong"
      : tone === "default"
        ? "text-kumo-default"
        : "text-kumo-subtle";
  return (
    <code
      title={title ?? (truncate ? children : undefined)}
      className={cn("font-mono text-xs", color, truncate && "block truncate", className)}
    >
      {children}
    </code>
  );
}

/** Shorten a hash for display while keeping the full value available via `title`. */
export function shortHash(value: string, length = 12): string {
  return value.length > length ? value.slice(0, length) : value;
}
