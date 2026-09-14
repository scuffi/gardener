import type { Policy, PolicyMode } from "../../../lib/types";
import { Mono, Radio } from "../../../primitives";

type ModeCopy = Record<PolicyMode, { label: string; description: string }>;

const modeStyles: Record<PolicyMode, string> = {
  disabled:
    "has-[[data-checked]]:!border-(--color-gardener-policy-disabled-edge) " +
    "has-[[data-checked]]:!bg-(--color-gardener-policy-disabled-surface) " +
    "has-[[data-checked]]:hover:!bg-(--color-gardener-policy-disabled-surface) " +
    "has-[[data-checked]]:[&_[data-kumo-part=item]]:!bg-(--color-gardener-policy-disabled-mark) " +
    "has-[[data-checked]]:[&_[data-kumo-part=item]]:!ring-(--color-gardener-policy-disabled-edge)",
  approval:
    "has-[[data-checked]]:!border-(--color-gardener-policy-approval-edge) " +
    "has-[[data-checked]]:!bg-(--color-gardener-policy-approval-surface) " +
    "has-[[data-checked]]:hover:!bg-(--color-gardener-policy-approval-surface) " +
    "has-[[data-checked]]:[&_[data-kumo-part=item]]:!bg-(--color-gardener-policy-approval-mark) " +
    "has-[[data-checked]]:[&_[data-kumo-part=item]]:!ring-(--color-gardener-policy-approval-edge)",
  automatic:
    "has-[[data-checked]]:!border-(--color-gardener-policy-automatic-edge) " +
    "has-[[data-checked]]:!bg-(--color-gardener-policy-automatic-surface) " +
    "has-[[data-checked]]:hover:!bg-(--color-gardener-policy-automatic-surface) " +
    "has-[[data-checked]]:[&_[data-kumo-part=item]]:!bg-(--color-gardener-policy-automatic-mark) " +
    "has-[[data-checked]]:[&_[data-kumo-part=item]]:!ring-(--color-gardener-policy-automatic-edge)",
};

export function PolicyRow({
  policy,
  value,
  metadata,
  modeCopy,
  onChange,
}: {
  policy: Policy;
  value: PolicyMode;
  metadata: { name: string; description: string };
  modeCopy: ModeCopy;
  onChange: (mode: PolicyMode) => void;
}) {
  return (
    <div
      className={
        "grid grid-cols-[minmax(240px,1fr)_minmax(480px,1.25fr)] items-center gap-4 " +
        "border-b border-kumo-hairline px-4 py-4 last:border-b-0 " +
        "max-xl:grid-cols-1"
      }
    >
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-kumo-strong">{metadata.name}</h3>
        <p className="mt-1 text-xs leading-relaxed text-kumo-subtle">{metadata.description}</p>
        <Mono className="mt-1 block" tone="subtle">
          {policy.operation_kind}
        </Mono>
      </div>
      <div className="min-w-0">
        <Radio.Group<PolicyMode>
          appearance="card"
          orientation="horizontal"
          controlPosition="start"
          name={`policy-${policy.operation_kind}`}
          value={value}
          onValueChange={onChange}
          className="[&>div]:grid-cols-3 [&>div]:gap-2 max-sm:[&>div]:grid-cols-1"
        >
          <Radio.Legend className="sr-only">Policy for {metadata.name}</Radio.Legend>
          {(Object.keys(modeCopy) as PolicyMode[]).map((mode) => (
            <Radio.Item<PolicyMode>
              key={mode}
              label={modeCopy[mode].label}
              value={mode}
              className={`min-w-0 hover:!bg-kumo-base ${modeStyles[mode]}`}
            />
          ))}
        </Radio.Group>
        <small className="mt-2 block text-xs text-kumo-subtle">
          {modeCopy[value].description}
        </small>
      </div>
    </div>
  );
}
