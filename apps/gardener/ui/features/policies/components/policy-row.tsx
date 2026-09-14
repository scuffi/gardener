import type { Policy, PolicyMode } from "../../../lib/types";
import { Grid, Mono, Radio } from "../../../primitives";

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
    <Grid
      variant="2-1"
      gap="base"
      className="items-center border-b border-kumo-hairline px-4 py-4 last:border-b-0 hover:bg-kumo-tint"
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
          name={`policy-${policy.operation_kind}`}
          value={value}
          onValueChange={onChange}
          className="grid grid-cols-3 gap-1"
        >
          <Radio.Legend className="sr-only">Policy for {metadata.name}</Radio.Legend>
          {(Object.keys(modeCopy) as PolicyMode[]).map((mode) => (
            <Radio.Item<PolicyMode>
              key={mode}
              label={modeCopy[mode].label}
              value={mode}
              className="min-w-0"
            />
          ))}
        </Radio.Group>
        <small className="mt-2 block text-xs text-kumo-subtle">
          {modeCopy[value].description}
        </small>
      </div>
    </Grid>
  );
}
