import { formatDate } from "../../../lib/format";
import type { RunEffect } from "../../../lib/types";
import {
  ClipboardText,
  EmptyState,
  Mono,
  Panel,
  PanelHeader,
  RunStatus,
  shortHash,
  Table,
} from "../../../primitives";

export function EffectsTable({ effects }: { effects: RunEffect[] }) {
  const orderedEffects = [...effects].sort((left, right) => left.created_at.localeCompare(right.created_at));

  return (
    <Panel padded={false}>
      <PanelHeader
        title="Effects and receipts"
        description="Authoritative record of GitHub operations admitted by policy and executed by Gardener."
      />
      {!orderedEffects.length ? (
        <EmptyState
          compact
          title="No effects were proposed"
          description="Policy-gated GitHub operations and their receipts will appear here."
        />
      ) : (
        <div className="min-w-0 overflow-x-auto">
          <Table className="min-w-[920px] text-sm">
            <Table.Header variant="compact">
              <Table.Row>
                <Table.Head sticky="left">Effect</Table.Head>
                <Table.Head>Policy mode</Table.Head>
                <Table.Head>Status</Table.Head>
                <Table.Head>Decided</Table.Head>
                <Table.Head>Executed</Table.Head>
                <Table.Head>Receipt</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {orderedEffects.map((effect) => (
                <Table.Row key={effect.id}>
                  <Table.Cell sticky="left" className="whitespace-nowrap">
                    <Mono tone="strong">{effect.effect_kind}</Mono>
                  </Table.Cell>
                  <Table.Cell className="whitespace-nowrap">
                    <Mono tone="default">{effect.policy_mode}</Mono>
                  </Table.Cell>
                  <Table.Cell className="whitespace-nowrap">
                    <RunStatus status={effect.status} />
                  </Table.Cell>
                  <Table.Cell className="whitespace-nowrap">{formatDate(effect.decided_at)}</Table.Cell>
                  <Table.Cell className="whitespace-nowrap">{formatDate(effect.executed_at)}</Table.Cell>
                  <Table.Cell className="w-44">
                    <ClipboardText
                      size="sm"
                      text={shortHash(effect.operation_id)}
                      textToCopy={effect.operation_id}
                      tooltip={{ text: "Copy receipt", copiedText: "Receipt copied", side: "top" }}
                    />
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </div>
      )}
    </Panel>
  );
}
