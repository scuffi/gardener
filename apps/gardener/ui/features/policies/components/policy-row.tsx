import type { Policy, PolicyMode } from "../../../lib/types";
import { Mono, Radio } from "../../../primitives";

type ModeCopy = Record<PolicyMode, { label: string; description: string }>;

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
              className={
                "min-w-0 transition-[border-color,box-shadow] duration-300 " +
                "ease-[cubic-bezier(0.22,1,0.36,1)] hover:border-kumo-line hover:!bg-kumo-base " +
                "hover:shadow-sm has-[[data-checked]]:hover:!bg-kumo-tint"
              }
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
