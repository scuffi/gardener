import { useEffect, useRef, type ReactNode } from "react";

/**
 * Title block for a surface.
 *
 * Moves focus to the heading on mount so that route changes announce the new surface to screen
 * readers and keyboard users start at the top of the content, not at the end of the sidebar.
 */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => titleRef.current?.focus({ preventScroll: true }), []);

  return (
    <header className="mb-6 flex items-start justify-between gap-7 max-sm:flex-col max-sm:gap-4">
      <div className="max-w-[760px]">
        <h1
          ref={titleRef}
          tabIndex={-1}
          className="mb-1.5 text-2xl font-semibold tracking-tight text-kumo-strong outline-none"
        >
          {title}
        </h1>
        {description ? (
          <p className="max-w-[720px] text-base leading-relaxed text-kumo-subtle">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center justify-end gap-2 max-sm:w-full max-sm:justify-start">
          {actions}
        </div>
      ) : null}
    </header>
  );
}
