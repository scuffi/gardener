import { FloppyDiskIcon, ShieldCheckIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useGardener } from "../../app-context";
import { gardenerApi } from "../../lib/api";
import { queryPrefixes } from "../../lib/query-keys";
import type { Policy, PolicyMode } from "../../lib/types";
import { operationMetadata } from "../../lib/types";
import { useNotifications } from "../../providers/notifications";
import {
  Banner,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Panel,
  PanelHeader,
} from "../../primitives";
import { PolicyRow } from "./components/policy-row";

const modeCopy: Record<PolicyMode, { label: string; description: string }> = {
  disabled: { label: "Disabled", description: "Gardener cannot execute this operation." },
  approval: { label: "Require approval", description: "A person must approve every proposal." },
  automatic: { label: "Automatic", description: "Valid proposals may execute without review." },
};

const policyGroups: Array<{
  title: string;
  description: string;
  operations: readonly string[];
}> = [
  {
    title: "Issues",
    description: "Labels, comments, assignees, and issue state.",
    operations: [
      "issue.label.add",
      "issue.label.remove",
      "issue.comment.create",
      "issue.comment.update",
      "issue.close",
      "issue.reopen",
      "issue.assignee.add",
      "issue.assignee.remove",
    ],
  },
  {
    title: "Pull requests",
    description: "Comments, reviewers, reviews, metadata, drafts, and protected merges.",
    operations: [
      "pull_request.comment.create",
      "pull_request.comment.update",
      "pull_request.reviewer.request",
      "pull_request.reviewer.remove",
      "pull_request.review.submit",
      "pull_request.update",
      "pull_request.open_draft",
      "pull_request.merge",
    ],
  },
  {
    title: "Code",
    description: "Bounded branches and local-workspace-generated commits.",
    operations: ["branch.create", "commit.create"],
  },
  {
    title: "Discussions",
    description: "Discussion comments, answers, and state.",
    operations: [
      "discussion.comment.create",
      "discussion.comment.update",
      "discussion.answer.mark",
      "discussion.answer.unmark",
      "discussion.close",
      "discussion.reopen",
    ],
  },
  {
    title: "Checks and releases",
    description: "Check reruns and draft, update, publication, or deletion of releases.",
    operations: [
      "check.rerun",
      "release.create",
      "release.update",
      "release.publish",
      "release.delete",
    ],
  },
];

function metadataFor(operation: string): { name: string; description: string } {
  return operation in operationMetadata
    ? operationMetadata[operation]!
    : { name: operation, description: "Control this GitHub operation." };
}

export function PoliciesPage() {
  const { state, stateLoading, error, refresh } = useGardener();
  const queryClient = useQueryClient();
  const { notify } = useNotifications();
  const [draft, setDraft] = useState<Record<string, PolicyMode>>({});
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    if (state) {
      setDraft(
        Object.fromEntries(state.policies.map((policy) => [policy.operation_kind, policy.mode])),
      );
    }
  }, [state]);

  const changed = useMemo(
    () =>
      state?.policies.filter(
        (policy) =>
          draft[policy.operation_kind] && draft[policy.operation_kind] !== policy.mode,
      ) ?? [],
    [draft, state],
  );
  const increasesAuthority = changed.some(
    (policy) => draft[policy.operation_kind] === "automatic",
  );
  const mutation = useMutation({
    mutationFn: () =>
      gardenerApi.setPolicies(
        changed.map((policy) => ({
          operation: policy.operation_kind,
          mode: draft[policy.operation_kind]!,
        })),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryPrefixes.state });
      setConfirmOpen(false);
      notify({
        tone: "success",
        title: "Policies saved",
        description: "New runs will use the updated operation permissions.",
      });
    },
    onError: (mutationError: Error) =>
      notify({
        tone: "error",
        title: "Unable to save policies",
        description: mutationError.message,
      }),
  });

  if (!state) {
    return (
      <>
        <PageHeader
          title="Policies"
          description="Choose which GitHub actions are off, require approval, or can run automatically."
        />
        {stateLoading ? (
          <Panel>
            <LoadingState label="Loading policies" />
          </Panel>
        ) : error ? (
          <ErrorState message={error.message} onRetry={() => void refresh()} />
        ) : null}
      </>
    );
  }

  const save = () => {
    if (increasesAuthority) {
      setConfirmOpen(true);
    } else {
      mutation.mutate();
    }
  };
  const reset = () =>
    setDraft(
      Object.fromEntries(state.policies.map((policy) => [policy.operation_kind, policy.mode])),
    );

  const policiesByKind = new Map(
    state.policies.map((policy) => [policy.operation_kind, policy]),
  );
  const knownKinds = new Set(policyGroups.flatMap((group) => group.operations));
  const unknownPolicies = state.policies.filter(
    (policy) => !knownKinds.has(policy.operation_kind),
  );
  const renderPolicy = (policy: Policy) => (
    <PolicyRow
      key={policy.operation_kind}
      policy={policy}
      value={draft[policy.operation_kind] ?? policy.mode}
      metadata={metadataFor(policy.operation_kind)}
      modeCopy={modeCopy}
      onChange={(mode) =>
        setDraft((current) => ({ ...current, [policy.operation_kind]: mode }))
      }
    />
  );

  return (
    <>
      <PageHeader
        title="Policies"
        description="Choose which GitHub actions are off, require approval, or can run automatically."
      />
      <Banner
        variant="secondary"
        icon={<ShieldCheckIcon size={20} weight="fill" />}
        title="Model output is never authorization"
        description={
          "Gardener applies these policies to every proposal. Connect revalidates repository access " +
          "and current GitHub state immediately before each write."
        }
      />
      {state.policies.length ? (
        <div className="mt-5 grid gap-5">
          {policyGroups.map((group) => {
            const policies = group.operations.flatMap((operation) => {
              const policy = policiesByKind.get(operation);
              return policy ? [policy] : [];
            });
            if (!policies.length) {
              return null;
            }
            return (
              <Panel key={group.title} padded={false}>
                <PanelHeader title={group.title} description={group.description} />
                {policies.map(renderPolicy)}
              </Panel>
            );
          })}
          {unknownPolicies.length ? (
            <Panel padded={false}>
              <PanelHeader
                title="Other operations"
                description="Additional operations provided by this Gardener version."
              />
              {unknownPolicies.map(renderPolicy)}
            </Panel>
          ) : null}
        </div>
      ) : (
        <Panel className="mt-5">
          <EmptyState
            icon={ShieldCheckIcon}
            title="No policies available"
            description="This Gardener version did not provide any GitHub operation policies."
          />
        </Panel>
      )}
      {changed.length ? (
        <div
          className={
            "sticky bottom-4 z-20 mt-4 flex items-center justify-between gap-5 rounded-lg border " +
            "border-kumo-line bg-kumo-elevated px-4 py-3 shadow-lg max-sm:bottom-2 max-sm:flex-col " +
            "max-sm:items-stretch"
          }
          role="region"
          aria-label="Unsaved policy changes"
        >
          <div className="grid">
            <strong className="text-xs text-kumo-strong">
              {changed.length} unsaved {changed.length === 1 ? "change" : "changes"}
            </strong>
            <span className="text-xs text-kumo-subtle">
              Changes apply to new runs after you save.
            </span>
          </div>
          <div className="flex gap-2 max-sm:[&>button]:flex-1">
            <Button variant="secondary" onClick={reset}>
              Discard
            </Button>
            <Button
              variant="primary"
              icon={FloppyDiskIcon}
              loading={mutation.isPending}
              onClick={save}
            >
              Save policies
            </Button>
          </div>
        </div>
      ) : null}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Allow automatic GitHub actions?"
        description={
          "At least one change allows Gardener to execute a valid proposal without human approval. " +
          "Access and current GitHub state will still be checked before every write."
        }
        detail={
          <div className="grid gap-1.5">
            {changed
              .filter((policy) => draft[policy.operation_kind] === "automatic")
              .map((policy) => (
                <span
                  key={policy.operation_kind}
                  className="flex items-center gap-2 text-xs text-kumo-warning"
                >
                  <WarningCircleIcon size={16} aria-hidden="true" />
                  {metadataFor(policy.operation_kind).name}
                </span>
              ))}
          </div>
        }
        confirmLabel="Allow and save"
        confirmTone="primary"
        loading={mutation.isPending}
        onConfirm={() => mutation.mutateAsync()}
      />
    </>
  );
}
