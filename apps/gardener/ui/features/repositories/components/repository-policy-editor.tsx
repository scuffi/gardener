import { FloppyDiskIcon, ShieldCheckIcon } from "@phosphor-icons/react";
import { useMutation, type UseQueryResult, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, gardenerApi } from "../../../lib/api";
import { queryPrefixes } from "../../../lib/query-keys";
import type {
  ObservationCapability,
  OperationKind,
  PolicyMode,
  PutRepositoryPolicyInput,
  RepositoryPolicyView,
  WorkspaceCapability,
  WorkspaceRole,
} from "../../../lib/types";
import { operationMetadata } from "../../../lib/types";
import { useNotifications } from "../../../providers/notifications";
import {
  Banner,
  Button,
  Collapsible,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LoadingState,
  Switch,
} from "../../../primitives";
import {
  modeLabels,
  modeRank,
  observationCapabilities,
  observationLabels,
  operationGroups,
  operationKinds,
  workspaceCapabilities,
  workspaceLabels,
} from "../constants";
import { RepositoryPolicyRow } from "./repository-policy-row";

type Draft = {
  operationModes: Record<OperationKind, PolicyMode>;
  allowedObservations: ObservationCapability[];
  workspaceModes: Record<WorkspaceCapability, PolicyMode>;
};

function draftFrom(view: RepositoryPolicyView): Draft {
  return {
    operationModes: Object.fromEntries(
      operationKinds.map((key) => [key, view.policy.operationModes[key] ?? "disabled"]),
    ) as Draft["operationModes"],
    allowedObservations: observationCapabilities.filter((key) =>
      view.policy.allowedObservations.includes(key),
    ),
    workspaceModes: Object.fromEntries(
      workspaceCapabilities.map((key) => [key, view.policy.workspaceModes[key] ?? "disabled"]),
    ) as Draft["workspaceModes"],
  };
}

function disabledDraft(): Draft {
  return {
    operationModes: Object.fromEntries(
      operationKinds.map((key) => [key, "disabled"]),
    ) as Draft["operationModes"],
    allowedObservations: [],
    workspaceModes: Object.fromEntries(
      workspaceCapabilities.map((key) => [key, "disabled"]),
    ) as Draft["workspaceModes"],
  };
}

function requestFrom(view: RepositoryPolicyView, draft: Draft): PutRepositoryPolicyInput {
  return {
    expectedPolicyVersion: view.policyVersion,
    expectedPolicyHash: view.configured ? view.policyHash : null,
    operationModes: draft.operationModes,
    allowedObservations: draft.allowedObservations,
    workspaceModes: draft.workspaceModes,
  };
}

function operationsFor(group: (typeof operationGroups)[number]): OperationKind[] {
  return operationKinds.filter(
    (kind) =>
      ("values" in group && group.values.some((value) => value === kind)) ||
      ("prefix" in group && kind.startsWith(group.prefix)),
  );
}

export function RepositoryPolicyEditor({
  repositoryId,
  role,
  query,
}: {
  repositoryId: string;
  role: WorkspaceRole;
  query: UseQueryResult<RepositoryPolicyView, Error>;
}) {
  const queryClient = useQueryClient();
  const { notify } = useNotifications();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirming, setConfirming] = useState<"configure" | "widen" | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const confirmationActive = useRef(false);
  const view = query.data;

  useEffect(() => {
    if (view) setDraft(draftFrom(view));
  }, [view]);

  const changed = useMemo(() => {
    if (!view || !draft) return false;
    return JSON.stringify(requestFrom(view, draft)) !== JSON.stringify(requestFrom(view, draftFrom(view)));
  }, [draft, view]);

  const widens = useMemo(() => {
    if (!view || !draft) return false;
    const operationWidened = operationKinds.some(
      (key) => modeRank[draft.operationModes[key]] > modeRank[view.policy.operationModes[key] ?? "disabled"],
    );
    const workspaceWidened = workspaceCapabilities.some(
      (key) => modeRank[draft.workspaceModes[key]] > modeRank[view.policy.workspaceModes[key] ?? "disabled"],
    );
    const observationWidened = draft.allowedObservations.some(
      (key) => !view.policy.allowedObservations.includes(key),
    );
    return operationWidened || workspaceWidened || observationWidened;
  }, [draft, view]);

  const mutation = useMutation({
    mutationFn: (input: PutRepositoryPolicyInput) =>
      gardenerApi.setRepositoryPolicy(repositoryId, input),
    onSuccess: async ({ result }) => {
      confirmationActive.current = false;
      setConfirming(null);
      setMutationError(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryPrefixes.repositories }),
        queryClient.invalidateQueries({ queryKey: queryPrefixes.state }),
      ]);
      notify({
        tone: "success",
        title: result === "noop" ? "Repository policy already current" : "Repository policy saved",
        description: result === "noop" ? "No authority changed." : "New runs use the saved policy.",
      });
    },
    onError: async (error: Error) => {
      confirmationActive.current = false;
      setConfirming(null);
      if (error instanceof ApiError && error.status === 409) {
        setMutationError("Policy changed elsewhere. The latest policy has been refreshed; review it again.");
        await query.refetch();
        return;
      }
      setMutationError(`Policy was not saved. ${error.message}`);
    },
  });

  if (query.isLoading) return <LoadingState label="Loading repository policy" />;
  if (query.error || !view) {
    return (
      <ErrorState
        message={query.error?.message ?? "Repository policy is unavailable."}
        onRetry={() => void query.refetch()}
      />
    );
  }

  const submit = (nextDraft: Draft) => mutation.mutate(requestFrom(view, nextDraft));
  if (!view.configured) {
    return (
      <div className="grid min-w-0 gap-3">
        <Banner
          variant="error"
          icon={<ShieldCheckIcon size={20} aria-hidden="true" />}
          title="Policy not configured — effects are disabled"
          description={
            "Matching assigned Agents still run and remain visible, but no persistent effect can " +
            "execute until a complete repository policy is configured."
          }
        />
        {mutationError ? (
          <Banner variant="error" title="Repository policy unavailable" description={mutationError} />
        ) : null}
        {role === "owner" ? (
          <Button
            variant="primary"
            loading={mutation.isPending}
            className="max-w-full max-sm:min-h-11 max-sm:whitespace-normal"
            onClick={() => {
              confirmationActive.current = true;
              setConfirming("configure");
            }}
          >
            Configure complete disabled policy
          </Button>
        ) : (
          <p className="text-sm text-kumo-subtle">
            Only the workspace Owner can configure a missing repository policy.
          </p>
        )}
        <ConfirmDialog
          open={confirming === "configure"}
          onOpenChange={(open) => {
            if (!open) {
              confirmationActive.current = false;
              setConfirming(null);
            }
          }}
          title="Configure this repository with no authority?"
          description={
            "This atomically creates all 29 operation, 10 observation, and 10 workspace entries. " +
            "Every entry is disabled and no observations are allowed, so Agent runs remain " +
            "proposal-only and no persistent effect can execute."
          }
          confirmLabel="Configure complete disabled policy"
          loading={mutation.isPending}
          onConfirm={() => {
            if (confirming !== "configure" || !confirmationActive.current) return;
            confirmationActive.current = false;
            return mutation.mutateAsync(requestFrom(view, disabledDraft()));
          }}
        />
      </div>
    );
  }

  if (!draft) return <LoadingState label="Preparing repository policy" />;
  const canChoose = (current: PolicyMode, ceiling: PolicyMode, next: PolicyMode) =>
    modeRank[next] <= modeRank[ceiling] && (role === "owner" || modeRank[next] <= modeRank[current]);

  return (
    <div className="grid min-w-0 gap-3">
      <Banner
        variant="secondary"
        title="Repository policy configured"
        description="Effective authority is the narrower of this repository policy and the workspace ceiling."
      />
      {mutationError ? (
        <Banner variant="error" title="Repository policy was not saved" description={mutationError} />
      ) : null}
      <Collapsible.Root>
        <Collapsible.DefaultTrigger className="max-sm:min-h-11">
          GitHub operations · all 29
        </Collapsible.DefaultTrigger>
        <Collapsible.DefaultPanel>
          <div className="grid gap-3">
            {operationGroups.map((group) => (
              <section
                key={group.label}
                className="min-w-0 overflow-hidden rounded-md border border-kumo-hairline"
              >
                <h3 className="bg-kumo-elevated px-3 py-2 text-sm font-semibold text-kumo-strong">
                  {group.label}
                </h3>
                {operationsFor(group).map((key) => {
                  const current = view.policy.operationModes[key] ?? "disabled";
                  const ceiling = view.workspaceCeilings.operationModes[key] ?? "disabled";
                  return (
                    <RepositoryPolicyRow
                      key={key}
                      id={key}
                      label={operationMetadata[key]?.name ?? key}
                      description={operationMetadata[key]?.description ?? "Control this operation."}
                      value={draft.operationModes[key]}
                      ceiling={ceiling}
                      effective={view.effective.operationModes[key] ?? "disabled"}
                      canChoose={(next) => canChoose(current, ceiling, next)}
                      onChange={(next) =>
                        setDraft((value) => value && {
                          ...value,
                          operationModes: { ...value.operationModes, [key]: next },
                        })
                      }
                    />
                  );
                })}
              </section>
            ))}
          </div>
        </Collapsible.DefaultPanel>
      </Collapsible.Root>
      <Collapsible.Root>
        <Collapsible.DefaultTrigger className="max-sm:min-h-11">
          Observations · all 10
        </Collapsible.DefaultTrigger>
        <Collapsible.DefaultPanel>
          <div className="grid gap-2 sm:grid-cols-2">
            {observationCapabilities.map((key) => {
              const checked = draft.allowedObservations.includes(key);
              const current = view.policy.allowedObservations.includes(key);
              const ceiling = view.workspaceCeilings.observation[key] ?? "disabled";
              const disabled = ceiling === "disabled" || (role !== "owner" && !current);
              return (
                <div key={key} className="min-w-0 rounded-md border border-kumo-hairline p-3">
                  <Switch
                    label={`${observationLabels[key]} · workspace ceiling ${modeLabels[ceiling]}`}
                    checked={checked}
                    disabled={disabled}
                    onCheckedChange={(allowed) =>
                      setDraft((value) => value && {
                        ...value,
                        allowedObservations: allowed
                          ? [...value.allowedObservations, key]
                          : value.allowedObservations.filter((item) => item !== key),
                      })
                    }
                  />
                  <p className="mt-1 text-xs text-kumo-subtle">
                    Effective: {view.effective.allowedObservations.includes(key) ? "Allowed" : "Disabled"}
                  </p>
                </div>
              );
            })}
          </div>
        </Collapsible.DefaultPanel>
      </Collapsible.Root>
      <Collapsible.Root>
        <Collapsible.DefaultTrigger className="max-sm:min-h-11">
          Workspace capabilities · all 10
        </Collapsible.DefaultTrigger>
        <Collapsible.DefaultPanel>
          {workspaceCapabilities.map((key) => {
            const current = view.policy.workspaceModes[key] ?? "disabled";
            const ceiling = view.workspaceCeilings.workspaceModes[key] ?? "disabled";
            return (
              <RepositoryPolicyRow
                key={key}
                id={key}
                label={workspaceLabels[key]}
                description="Control this capability inside the run-scoped workspace."
                value={draft.workspaceModes[key]}
                ceiling={ceiling}
                effective={view.effective.workspaceModes[key] ?? "disabled"}
                canChoose={(next) => canChoose(current, ceiling, next)}
                onChange={(next) =>
                  setDraft((value) => value && {
                    ...value,
                    workspaceModes: { ...value.workspaceModes, [key]: next },
                  })
                }
              />
            );
          })}
        </Collapsible.DefaultPanel>
      </Collapsible.Root>
      {changed ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-kumo-elevated p-3">
          <p className="text-xs text-kumo-subtle">
            {widens ? "This change widens repository authority." : "This change strictly narrows authority."}
          </p>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              className="max-sm:min-h-11"
              onClick={() => setDraft(draftFrom(view))}
            >
              Discard
            </Button>
            <Button
              variant="primary"
              icon={FloppyDiskIcon}
              loading={mutation.isPending}
              className="max-sm:min-h-11 max-sm:whitespace-normal"
              onClick={() => {
                if (!widens) {
                  submit(draft);
                  return;
                }
                confirmationActive.current = true;
                setConfirming("widen");
              }}
            >
              Save repository policy
            </Button>
          </div>
        </div>
      ) : (
        <EmptyState compact title="Repository policy is current" description="There are no unsaved changes." />
      )}
      <ConfirmDialog
        open={confirming === "widen"}
        onOpenChange={(open) => {
          if (!open) {
            confirmationActive.current = false;
            setConfirming(null);
          }
        }}
        title="Widen this repository's authority?"
        description={
          "The selected operation, observation, and workspace changes may allow new Agent behavior. " +
          "The displayed workspace ceilings remain authoritative."
        }
        confirmLabel="Widen and save repository policy"
        loading={mutation.isPending}
        onConfirm={() => {
          if (confirming !== "widen" || !confirmationActive.current) return;
          confirmationActive.current = false;
          return mutation.mutateAsync(requestFrom(view, draft));
        }}
      />
    </div>
  );
}
