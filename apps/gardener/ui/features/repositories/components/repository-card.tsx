import {
  GithubLogoIcon,
  GitBranchIcon,
  PauseIcon,
  PlayIcon,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { gardenerApi } from "../../../lib/api";
import { isEnabled } from "../../../lib/format";
import { queryKeys, queryPrefixes } from "../../../lib/query-keys";
import type { Repository, WorkspaceRole } from "../../../lib/types";
import { useNotifications } from "../../../providers/notifications";
import {
  Button,
  Collapsible,
  ConfirmDialog,
  StatusBadge,
  statusTone,
} from "../../../primitives";
import { RepositoryAssignmentList } from "./repository-assignment-list";
import { RepositoryPolicyEditor } from "./repository-policy-editor";

export function RepositoryCard({
  repository,
  role,
  onManageInstallation,
}: {
  repository: Repository;
  role: WorkspaceRole;
  onManageInstallation: () => void;
}) {
  const queryClient = useQueryClient();
  const { notify } = useNotifications();
  const [open, setOpen] = useState(false);
  const [confirmResume, setConfirmResume] = useState(false);
  const resumeConfirmationActive = useRef(false);
  const active = isEnabled(repository.active);
  const name = `${repository.owner}/${repository.name}`;
  const assignments = useQuery({
    queryKey: queryKeys.repositoryAssignments(repository.id),
    queryFn: () => gardenerApi.repositoryAssignments(repository.id),
  });
  const policy = useQuery({
    queryKey: queryKeys.repositoryPolicy(repository.id),
    queryFn: () => gardenerApi.repositoryPolicy(repository.id),
  });
  const pauseMutation = useMutation({
    mutationFn: (paused: boolean) => gardenerApi.setRepositoryPaused(repository.id, paused),
    onSuccess: async ({ paused }) => {
      resumeConfirmationActive.current = false;
      setConfirmResume(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryPrefixes.state }),
        queryClient.invalidateQueries({ queryKey: queryPrefixes.repositories }),
      ]);
      notify({
        tone: "success",
        title: paused ? "Repository paused" : "Repository resumed",
        description: paused
          ? "New runs are paused; in-flight operations may finish."
          : "New matching events may start Agent runs when Gardener is globally active.",
      });
    },
    onError: (error: Error) =>
      notify({
        tone: "error",
        title: "Repository status was not changed",
        description: error.message,
      }),
  });
  const assignmentCount = assignments.data?.assignments.filter(
    (assignment) => assignment.removedAt === null,
  ).length;
  const configured = policy.data?.configured;
  const automaticOperations = policy.data
    ? Object.values(policy.data.effective.operationModes).filter((mode) => mode === "automatic").length
    : 0;
  const status = !active ? "access_removed" : repository.paused ? "paused" : "active";

  return (
    <article className="min-w-0 overflow-hidden rounded-lg border border-kumo-line bg-kumo-base shadow-sm">
      <Collapsible.Root open={open} onOpenChange={setOpen}>
        <Collapsible.Trigger
          className={
            "flex min-h-20 w-full items-center justify-between gap-4 px-4 py-3 text-left " +
            "hover:bg-kumo-tint max-sm:items-start"
          }
        >
          <span className="flex min-w-0 items-center gap-3">
            <span className="grid size-10 flex-none place-items-center rounded-md bg-kumo-recessed">
              <GitBranchIcon size={20} className="text-kumo-subtle" aria-hidden="true" />
            </span>
            <span className="min-w-0">
              <strong className="block truncate text-base font-semibold text-kumo-strong">{name}</strong>
              <span className="mt-1 block text-xs text-kumo-default">
                {assignments.isLoading
                  ? "Loading assigned Agents…"
                  : assignments.error
                    ? "Assigned Agents unavailable"
                    : `${assignmentCount} assigned ${assignmentCount === 1 ? "Agent" : "Agents"}`}
                {" · "}
                {policy.isLoading
                  ? "Loading policy…"
                  : policy.error
                    ? "Policy unavailable"
                    : configured
                      ? `${automaticOperations} operations effective automatically`
                      : "Policy not configured — effects disabled"}
              </span>
            </span>
          </span>
          <span className="flex flex-none items-center gap-2 max-sm:flex-col max-sm:items-end">
            <StatusBadge tone={statusTone(status)}>
              {!active ? "Access removed" : repository.paused ? "Paused" : "Active"}
            </StatusBadge>
            <span className="text-xs font-semibold text-kumo-link">
              {open ? "Hide details" : "View details"}
            </span>
          </span>
        </Collapsible.Trigger>
        <Collapsible.Panel keepMounted className="border-t border-kumo-hairline">
          <div className="flex flex-wrap gap-2 bg-kumo-elevated px-4 py-3">
            {active && !repository.paused ? (
              <Button
                variant="secondary"
                icon={PauseIcon}
                loading={pauseMutation.isPending}
                className="max-sm:min-h-11"
                onClick={() => pauseMutation.mutate(true)}
              >
                Pause repository
              </Button>
            ) : null}
            {active && repository.paused && role === "owner" ? (
              <Button
                variant="primary"
                icon={PlayIcon}
                loading={pauseMutation.isPending}
                className="max-sm:min-h-11"
                onClick={() => {
                  resumeConfirmationActive.current = true;
                  setConfirmResume(true);
                }}
              >
                Resume repository
              </Button>
            ) : null}
            {role === "owner" ? (
              <Button
                variant="secondary"
                icon={GithubLogoIcon}
                className="max-sm:min-h-11 max-sm:whitespace-normal"
                onClick={onManageInstallation}
              >
                Manage GitHub installation
              </Button>
            ) : null}
          </div>
          <div
            className="grid min-w-0 grid-cols-1 gap-4 p-4 2xl:grid-cols-2"
            data-testid="repository-detail-layout"
          >
            <section
              className="min-w-0"
              aria-labelledby={`assignments-${repository.id}`}
            >
              <h2
                id={`assignments-${repository.id}`}
                className="mb-2 text-sm font-semibold text-kumo-strong"
              >
                Assigned Agents
              </h2>
              <RepositoryAssignmentList query={assignments} />
            </section>
            <section
              className="min-w-0"
              aria-labelledby={`policy-${repository.id}`}
            >
              <h2
                id={`policy-${repository.id}`}
                className="mb-2 text-sm font-semibold text-kumo-strong"
              >
                Repository policy
              </h2>
              <RepositoryPolicyEditor
                repositoryId={repository.id}
                role={role}
                query={policy}
              />
            </section>
          </div>
        </Collapsible.Panel>
      </Collapsible.Root>
      <ConfirmDialog
        open={confirmResume}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) resumeConfirmationActive.current = false;
          setConfirmResume(nextOpen);
        }}
        title={`Resume ${name}?`}
        description="New matching events may start Agent runs when Gardener is globally active."
        confirmLabel={`Resume ${name}`}
        loading={pauseMutation.isPending}
        onConfirm={() => {
          if (!confirmResume || !resumeConfirmationActive.current) return;
          resumeConfirmationActive.current = false;
          return pauseMutation.mutateAsync(false);
        }}
      />
    </article>
  );
}
