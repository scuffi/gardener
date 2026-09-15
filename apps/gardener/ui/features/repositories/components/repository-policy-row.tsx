import type { PolicyMode } from "../../../lib/types";
import { Mono, Radio } from "../../../primitives";
import { modeLabels, policyModes } from "../constants";

const modeStyles: Record<PolicyMode, string> = {
  disabled:
    "has-[[data-checked]]:!border-(--color-gardener-policy-disabled-edge) " +
    "has-[[data-checked]]:!bg-(--color-gardener-policy-disabled-surface) " +
    "has-[[data-checked]]:[&_[data-kumo-part=item]]:!bg-(--color-gardener-policy-disabled-mark)",
  approval:
    "has-[[data-checked]]:!border-(--color-gardener-policy-approval-edge) " +
    "has-[[data-checked]]:!bg-(--color-gardener-policy-approval-surface) " +
    "has-[[data-checked]]:[&_[data-kumo-part=item]]:!bg-(--color-gardener-policy-approval-mark)",
  automatic:
    "has-[[data-checked]]:!border-(--color-gardener-policy-automatic-edge) " +
    "has-[[data-checked]]:!bg-(--color-gardener-policy-automatic-surface) " +
    "has-[[data-checked]]:[&_[data-kumo-part=item]]:!bg-(--color-gardener-policy-automatic-mark)",
};

export function RepositoryPolicyRow({
  id,
  label,
  description,
  value,
  ceiling,
  effective,
  canChoose,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  value: PolicyMode;
  ceiling: PolicyMode;
  effective: PolicyMode;
  canChoose: (mode: PolicyMode) => boolean;
  onChange: (mode: PolicyMode) => void;
}) {
  return (
    <div className="grid min-w-0 gap-3 border-b border-kumo-hairline px-3 py-3 last:border-b-0">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 break-words">
          <h4 className="text-sm font-semibold text-kumo-strong">{label}</h4>
          <p className="mt-0.5 text-xs text-kumo-subtle">{description}</p>
          <Mono className="mt-1 block" tone="subtle">
            {id}
          </Mono>
        </div>
        <span className="min-w-0 break-words text-xs text-kumo-subtle">
          Workspace ceiling: {modeLabels[ceiling]} · Effective: {modeLabels[effective]}
        </span>
      </div>
      <Radio.Group<PolicyMode>
        appearance="card"
        orientation="horizontal"
        controlPosition="start"
        name={`repository-policy-${id}`}
        value={value}
        onValueChange={onChange}
        className="[&>div]:grid-cols-3 [&>div]:gap-2 max-sm:[&>div]:grid-cols-1"
      >
        <Radio.Legend className="sr-only">Policy for {label}</Radio.Legend>
        {policyModes.map((mode) => (
          <Radio.Item<PolicyMode>
            key={mode}
            label={modeLabels[mode]}
            value={mode}
            disabled={!canChoose(mode)}
            className={`min-h-11 min-w-0 hover:!bg-kumo-base ${modeStyles[mode]}`}
          />
        ))}
      </Radio.Group>
    </div>
  );
}
