import type { AgentCapabilityReview as AgentCapabilityReviewData } from "../../../lib/types";
import { Mono, StatusBadge, statusTone } from "../../../primitives";

function capabilityName(value: string | { capability: string }) {
  return typeof value === "string" ? value : value.capability;
}

export function CapabilityReview({ review }: { review?: AgentCapabilityReviewData }) {
  const groups = review
    ? ([
        ["Observation", review.observation],
        ["Workspace", review.workspace.map(capabilityName)],
        ["Persistent effects", review.effects.map(capabilityName)],
      ] as const)
    : [];

  if (!groups.length) {
    return (
      <p className="p-4 text-sm text-kumo-subtle">
        Validate the source to review its exact requested capabilities.
      </p>
    );
  }

  return (
    <div>
      {groups.map(([label, values]) => (
        <section
          key={label}
          className="border-b border-kumo-hairline px-4 py-3 last:border-b-0"
        >
          <h3 className="text-xs font-semibold tracking-wide text-kumo-strong uppercase">{label}</h3>
          {values.length ? (
            <ul className="mt-2 grid list-none gap-2 p-0">
              {values.map((value) => (
                <li key={value} className="flex min-w-0 items-center justify-between gap-2">
                  <Mono className="min-w-0 break-all" tone="default" title={value}>
                    {value}
                  </Mono>
                  {label === "Persistent effects" ? (
                    <StatusBadge tone={statusTone("pending")}>Policy checked</StatusBadge>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-xs text-kumo-subtle">None requested</p>
          )}
        </section>
      ))}
    </div>
  );
}
