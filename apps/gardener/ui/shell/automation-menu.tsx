import { CaretDownIcon, PauseIcon, PlayIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useGardener } from "../app-context";
import { gardenerApi } from "../lib/api";
import { isEnabled } from "../lib/format";
import { queryPrefixes } from "../lib/query-keys";
import { Button, cn, ConfirmDialog, DropdownMenu } from "../primitives";
import { useNotifications } from "../providers/notifications";

export function AutomationMenu() {
  const { state, health } = useGardener();
  const { notify } = useNotifications();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [pendingResume, setPendingResume] = useState<
    { kind: "global" } | { kind: "repository"; id: string; name: string } | null
  >(null);
  const repositories = state?.repositories.filter((repository) => isEnabled(repository.active)) ?? [];
  const unpaused = repositories.filter((repository) => !repository.paused).length;
  const globallyPaused = Boolean(state?.globalPaused);
  const healthIssue = health?.ok === false;
  const active = !healthIssue && !globallyPaused && unpaused > 0;

  const status = healthIssue
    ? "Gardener needs attention"
    : globallyPaused
      ? "Gardener paused"
      : repositories.length === 0
        ? "No active repositories"
        : unpaused === 0
          ? "All repositories paused"
          : "Gardener active";

  const summary = healthIssue
    ? "A required Cloudflare service is unavailable."
    : globallyPaused || (repositories.length > 0 && unpaused === 0)
      ? "New work is paused; in-flight operations may finish."
      : repositories.length === 0
        ? "Connect a repository to start listening."
        : `${unpaused} of ${repositories.length} repositories listening.`;

  const globalMutation = useMutation({
    mutationFn: gardenerApi.setPaused,
    onSuccess: async ({ globalPaused }) => {
      await queryClient.invalidateQueries({ queryKey: queryPrefixes.state });
      setPendingResume(null);
      notify({
        tone: "success",
        title: globalPaused ? "Gardener paused" : "Gardener resumed",
        description: globalPaused
          ? "New work is paused. Operations already in progress may finish."
          : "Repository-specific pause settings remain in effect.",
      });
    },
    onError: (error: Error) =>
      notify({ tone: "error", title: "Unable to update Gardener", description: error.message }),
  });

  const repositoryMutation = useMutation({
    mutationFn: ({ id, paused }: { id: string; paused: boolean }) =>
      gardenerApi.setRepositoryPaused(id, paused),
    onSuccess: async ({ id, paused }) => {
      await queryClient.invalidateQueries({ queryKey: queryPrefixes.state });
      setPendingResume(null);
      const repository = repositories.find((candidate) => candidate.id === id);
      notify({
        tone: "success",
        title: paused ? "Repository paused" : "Repository resumed",
        description: repository
          ? `${repository.owner}/${repository.name}`
          : "Repository automation updated.",
      });
    },
    onError: (error: Error) =>
      notify({ tone: "error", title: "Unable to update repository", description: error.message }),
  });

  if (!state?.setup.completed) return null;

  return (
    <>
      <DropdownMenu>
      <DropdownMenu.Trigger>
        <Button
          id="automation-menu-trigger"
          type="button"
          variant="secondary"
          aria-label={`${status}. Open automation controls`}
          className={
            "min-w-0 gap-2 text-xs font-semibold max-[900px]:min-h-11 " +
            "max-[480px]:max-w-40 max-[480px]:px-2.5"
          }
        >
          <span
            aria-hidden="true"
            className={cn(
              "size-2 flex-none rounded-full",
              active
                ? "bg-kumo-success ring-3 ring-kumo-success/15"
                : "bg-kumo-warning ring-3 ring-kumo-warning/15",
            )}
          />
          <span className="truncate">{status}</span>
          <CaretDownIcon size={13} aria-hidden="true" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content
        align="end"
        sideOffset={8}
        data-automation-menu
        className="z-[260] w-80 p-1.5"
      >
        <DropdownMenu.Group>
          <DropdownMenu.Label className="grid! gap-0.5 px-2 py-2.5! font-normal!">
            <strong className="text-[13px] font-semibold text-kumo-strong">{status}</strong>
            <span className="text-[11px] text-kumo-subtle">{summary}</span>
          </DropdownMenu.Label>
        </DropdownMenu.Group>
        {healthIssue ? (
          <>
            <DropdownMenu.Separator />
            <DropdownMenu.Item icon={WarningCircleIcon} onClick={() => navigate("/settings")}>
              Review deployment health
            </DropdownMenu.Item>
          </>
        ) : null}
        <DropdownMenu.Separator />
        <DropdownMenu.Item
          icon={globallyPaused ? PlayIcon : PauseIcon}
          disabled={globalMutation.isPending}
          onClick={() => {
            if (globallyPaused) {
              setPendingResume({ kind: "global" });
            } else {
              globalMutation.mutate(true);
            }
          }}
        >
          {globallyPaused ? "Resume Gardener globally" : "Pause Gardener globally"}
        </DropdownMenu.Item>
        <DropdownMenu.Separator />
        <DropdownMenu.Group>
          <DropdownMenu.Label className="pt-1.5! text-[11px]! font-semibold! text-kumo-subtle">
            Repositories
          </DropdownMenu.Label>
          {repositories.map((repository) => (
            <DropdownMenu.CheckboxItem
              key={repository.id}
              data-repository-id={repository.id}
              checked={!repository.paused}
              closeOnClick={repository.paused}
              disabled={repositoryMutation.isPending}
              onCheckedChange={(checked) => {
                if (checked) {
                  setPendingResume({
                    kind: "repository",
                    id: repository.id,
                    name: `${repository.owner}/${repository.name}`,
                  });
                } else {
                  repositoryMutation.mutate({ id: repository.id, paused: true });
                }
              }}
            >
              <span className="grid min-w-0 leading-snug">
                <strong className="truncate text-xs font-medium">
                  {repository.owner}/{repository.name}
                </strong>
                <span className="mt-0.5 text-[11px] text-kumo-subtle">
                  {repository.paused
                    ? "Paused · in-flight work may finish"
                    : globallyPaused
                      ? "Ready when Gardener resumes"
                      : "Active"}
                </span>
              </span>
            </DropdownMenu.CheckboxItem>
          ))}
          {repositories.length === 0 ? (
            <div className="p-2 text-[11px] text-kumo-subtle">No connected repositories</div>
          ) : null}
        </DropdownMenu.Group>
        </DropdownMenu.Content>
      </DropdownMenu>
      <ConfirmDialog
        open={Boolean(pendingResume)}
        onOpenChange={(open) => {
          if (!open) setPendingResume(null);
        }}
        title={
          pendingResume?.kind === "repository"
            ? `Resume ${pendingResume.name}?`
            : "Resume Gardener globally?"
        }
        description={
          pendingResume?.kind === "repository"
            ? "New matching events in this repository may start Agent runs when Gardener is globally active."
            : "New work may start in every unpaused repository. Repository pauses and policies still apply."
        }
        confirmLabel={
          pendingResume?.kind === "repository"
            ? `Resume ${pendingResume.name}`
            : "Resume Gardener globally"
        }
        loading={globalMutation.isPending || repositoryMutation.isPending}
        onConfirm={() =>
          pendingResume?.kind === "repository"
            ? repositoryMutation.mutateAsync({ id: pendingResume.id, paused: false })
            : globalMutation.mutateAsync(false)
        }
      />
    </>
  );
}
