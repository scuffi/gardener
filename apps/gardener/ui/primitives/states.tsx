import { ArrowClockwiseIcon, WarningCircleIcon, type Icon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { Banner, Empty, Loader } from "./kumo";

/**
 * The three non-loaded states every surface must implement. See `ui/AGENTS.md`.
 *
 * Prefer a skeleton over `LoadingState` for content areas — see `skeletons.tsx`. `LoadingState` is
 * for short inline waits and for actions.
 */

export function LoadingState({ label = "Loading" }: { label?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-40 items-center justify-center gap-2.5 text-sm text-kumo-subtle"
    >
      <Loader size={16} aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

/**
 * Empty states must explain what *would* appear here, so an operator can tell "nothing happened
 * yet" apart from "something is misconfigured".
 */
export function EmptyState({
  icon: IconComponent,
  title,
  description,
  action,
  compact = false,
}: {
  icon?: Icon;
  title: string;
  description: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <Empty
      size={compact ? "sm" : "base"}
      icon={IconComponent ? <IconComponent size={compact ? 32 : 40} aria-hidden="true" /> : undefined}
      title={title}
      description={description}
      contents={action}
    />
  );
}

export function ErrorState({
  title = "Unable to load this page",
  message,
  onRetry,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <Banner
      variant="error"
      icon={<WarningCircleIcon size={20} weight="fill" />}
      title={title}
      description={message}
      action={
        onRetry ? (
          <Banner.Action
            variant="secondary"
            icon={ArrowClockwiseIcon}
            className="max-[900px]:min-h-11 max-[900px]:min-w-11"
            onClick={onRetry}
          >
            Try again
          </Banner.Action>
        ) : undefined
      }
    />
  );
}
