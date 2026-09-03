import { Button } from "@cloudflare/kumo/components/button";
import { DropdownMenu } from "@cloudflare/kumo/components/dropdown";
import { CaretDownIcon, PauseIcon, PlayIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useGardener } from "../app-context";
import { gardenerApi } from "../lib/api";
import { isEnabled } from "../lib/format";
import { useNotifications } from "./notifications";

export function AutomationMenu() {
  const { state, health } = useGardener();
  const { notify } = useNotifications();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const repositories = state?.repositories.filter((repository) => isEnabled(repository.active)) ?? [];
  const unpaused = repositories.filter((repository) => !repository.paused).length;
  const globallyPaused = Boolean(state?.globalPaused);
  const healthIssue = health?.ok === false;
  const active = !healthIssue && !globallyPaused && unpaused > 0;
  const status = healthIssue ? "Gardener needs attention" : globallyPaused ? "Gardener paused" : repositories.length === 0 ? "No active repositories" : unpaused === 0 ? "All repositories paused" : "Gardener active";

  const globalMutation = useMutation({
    mutationFn: gardenerApi.setPaused,
    onSuccess: async ({ globalPaused }) => {
      await queryClient.invalidateQueries({ queryKey: ["state"] });
      notify({
        tone: "success",
        title: globalPaused ? "Gardener paused" : "Gardener resumed",
        description: globalPaused ? "New work is paused. Operations already in progress may finish." : "Repository-specific pause settings remain in effect.",
      });
    },
    onError: (error: Error) => notify({ tone: "error", title: "Unable to update Gardener", description: error.message }),
  });
  const repositoryMutation = useMutation({
    mutationFn: ({ id, paused }: { id: string; paused: boolean }) => gardenerApi.setRepositoryPaused(id, paused),
    onSuccess: async ({ id, paused }) => {
      await queryClient.invalidateQueries({ queryKey: ["state"] });
      const repository = repositories.find((candidate) => candidate.id === id);
      notify({
        tone: "success",
        title: paused ? "Repository paused" : "Repository resumed",
        description: repository ? `${repository.owner}/${repository.name}` : "Repository automation updated.",
      });
    },
    onError: (error: Error) => notify({ tone: "error", title: "Unable to update repository", description: error.message }),
  });
  if (!state?.setup.completed) return null;

  return <DropdownMenu>
    <DropdownMenu.Trigger>
      <Button id="automation-menu-trigger" type="button" variant="secondary" className={`automation-menu-trigger${active ? " is-active" : " is-paused"}`} aria-label={`${status}. Open automation controls`}>
        <span className="automation-menu-trigger__dot" aria-hidden="true" />
        <span>{status}</span>
        <CaretDownIcon size={13} aria-hidden="true" />
      </Button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Content align="end" sideOffset={8} className="automation-menu-content" data-automation-menu>
      <DropdownMenu.Group>
        <DropdownMenu.Label className="automation-menu-summary">
          <strong>{status}</strong>
          <span>{healthIssue ? "A required Cloudflare service is unavailable." : globallyPaused || (repositories.length > 0 && unpaused === 0) ? "New work is paused; in-flight operations may finish." : repositories.length === 0 ? "Connect a repository to start listening." : `${unpaused} of ${repositories.length} repositories listening.`}</span>
        </DropdownMenu.Label>
      </DropdownMenu.Group>
      {healthIssue ? <>
        <DropdownMenu.Separator />
        <DropdownMenu.Item icon={WarningCircleIcon} onClick={() => navigate("/settings")}>Review deployment health</DropdownMenu.Item>
      </> : null}
      <DropdownMenu.Separator />
      <DropdownMenu.Item
        icon={globallyPaused ? PlayIcon : PauseIcon}
        disabled={globalMutation.isPending}
        onClick={() => globalMutation.mutate(!globallyPaused)}
      >
        {globallyPaused ? "Resume Gardener globally" : "Pause Gardener globally"}
      </DropdownMenu.Item>
      <DropdownMenu.Separator />
      <DropdownMenu.Group>
        <DropdownMenu.Label className="automation-menu-label">Repositories</DropdownMenu.Label>
        {repositories.map((repository) => <DropdownMenu.CheckboxItem
          key={repository.id}
          data-repository-id={repository.id}
          checked={!repository.paused}
          closeOnClick={false}
          disabled={repositoryMutation.isPending}
          onCheckedChange={(checked) => repositoryMutation.mutate({ id: repository.id, paused: !checked })}
        >
          <span className="automation-repository-item"><strong>{repository.owner}/{repository.name}</strong><small>{repository.paused ? "Paused · in-flight work may finish" : globallyPaused ? "Ready when Gardener resumes" : "Active"}</small></span>
        </DropdownMenu.CheckboxItem>)}
        {repositories.length === 0 ? <div className="automation-menu-empty">No connected repositories</div> : null}
      </DropdownMenu.Group>
    </DropdownMenu.Content>
  </DropdownMenu>;
}
