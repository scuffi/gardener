import type { ReactNode } from "react";
import { sentenceCase } from "../lib/format";
import { Badge } from "./kumo";

/**
 * The dashboard's single status vocabulary. See `docs/design-system.md` §4.
 *
 * Domain states map to exactly one tone so that "warning" always means the same thing on every
 * surface. Do not introduce a second mapping in a feature.
 */
export type StatusTone = "success" | "warning" | "danger" | "info" | "neutral";

const toneByState: Record<string, StatusTone> = {
  // Succeeded / healthy / live.
  completed: "success",
  executed: "success",
  enabled: "success",
  active: "success",
  connected: "success",
  approved: "success",
  ready: "success",
  available: "success",
  // Waiting on a person, or deliberately held.
  queued: "warning",
  pending: "warning",
  executing: "warning",
  running: "warning",
  awaiting_approval: "warning",
  paused: "warning",
  waiting: "warning",
  degraded: "warning",
  high: "warning",
  // Failed or withdrawn.
  failed: "danger",
  completed_with_errors: "danger",
  blocked: "danger",
  rejected: "danger",
  access_removed: "danger",
  unavailable: "danger",
  cancelled: "danger",
  urgent: "danger",
  // Observed but not acted on.
  observing: "info",
  simulated: "info",
  draft: "info",
  // Inert.
  disabled: "neutral",
  dismissed: "neutral",
  resolved: "neutral",
  none: "neutral",
  normal: "neutral",
  low: "neutral",
};

/** Resolve a raw domain status string to its tone, defaulting to neutral. */
export function statusTone(status: string): StatusTone {
  return toneByState[status.toLowerCase()] ?? "neutral";
}

export function StatusBadge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: StatusTone;
}) {
  const variant = tone === "danger" ? "error" : tone === "info" ? "neutral" : tone;
  return (
    <Badge
      variant={variant}
      appearance={tone === "neutral" ? "filled" : "dot"}
      className="[a:hover_&]:!ring-kumo-hairline"
    >
      {tone === "info" ? <span className="sr-only">Informational status: </span> : null}
      {children}
    </Badge>
  );
}

/** Badge for a raw run/effect/task status string, using the shared vocabulary. */
export function RunStatus({ status }: { status: string }) {
  return <StatusBadge tone={statusTone(status)}>{sentenceCase(status)}</StatusBadge>;
}
