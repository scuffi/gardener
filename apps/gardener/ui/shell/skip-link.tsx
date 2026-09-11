import { cn } from "../primitives";

/**
 * Keyboard bypass for the sidebar. Hidden until focused, then pinned to the top-left.
 */
export function SkipLink({
  href = "#main-content",
  children = "Skip to content",
}: {
  href?: string;
  children?: string;
}) {
  return (
    <a
      href={href}
      className={cn(
        "fixed top-2 left-2 z-[1000] -translate-y-[160%] rounded-md px-3 py-2",
        "bg-kumo-brand font-semibold text-kumo-inverse no-underline",
        "focus:translate-y-0",
      )}
    >
      {children}
    </a>
  );
}
