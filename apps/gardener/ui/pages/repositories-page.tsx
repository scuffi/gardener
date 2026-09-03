import { Button } from "@cloudflare/kumo/components/button";
import { ArrowClockwiseIcon, GithubLogoIcon, GitBranchIcon, ShieldCheckIcon } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useGardener } from "../app-context";
import { gardenerApi } from "../lib/api";
import { formatRelativeTime, isEnabled } from "../lib/format";
import { useNotifications } from "../components/notifications";
import { EmptyState, PageHeader, StatusBadge, Surface } from "../components/ui";

export function RepositoriesPage() {
  const { state } = useGardener();
  const queryClient = useQueryClient();
  const { notify } = useNotifications();
  const installMutation = useMutation({
    mutationFn: gardenerApi.beginInstallation,
    onSuccess: ({ installationUrl }) => { location.href = installationUrl; },
    onError: (error: Error) => notify({ tone: "error", title: "Unable to open GitHub", description: error.message }),
  });
  const syncMutation = useMutation({
    mutationFn: gardenerApi.syncRepositories,
    onSuccess: async ({ repositories }) => {
      await queryClient.invalidateQueries({ queryKey: ["state"] });
      notify({ tone: "success", title: "Repository access synchronized", description: `${repositories.length} ${repositories.length === 1 ? "repository" : "repositories"} returned by GitHub.` });
    },
    onError: (error: Error) => notify({ tone: "error", title: "Repository sync failed", description: error.message }),
  });
  if (!state) return null;

  return <>
    <PageHeader
      title="Repositories"
      description="Choose where Gardener may observe events and propose or execute actions. Repository access remains controlled by the GitHub App installation."
      actions={<><Button variant="secondary" icon={ArrowClockwiseIcon} loading={syncMutation.isPending} onClick={() => syncMutation.mutate()}>Sync access</Button><Button variant="primary" icon={GithubLogoIcon} loading={installMutation.isPending} onClick={() => installMutation.mutate()}>Manage repositories</Button></>}
    />
    <Surface padded={false}>
      {state.repositories.length ? <><div className="mobile-data-list">{state.repositories.map((repository) => <article className="mobile-data-card" key={repository.id}>
        <div className="mobile-data-card__title"><span className="cell-with-icon"><GitBranchIcon size={17} aria-hidden="true" /><strong className="repo-name">{repository.owner}/{repository.name}</strong></span><StatusBadge tone={isEnabled(repository.active) ? "success" : "error"}>{isEnabled(repository.active) ? "Connected" : "Access removed"}</StatusBadge></div>
        <dl><div><dt>Default branch</dt><dd><code>{repository.default_branch ?? "—"}</code></dd></div><div><dt>Last synchronized</dt><dd>{formatRelativeTime(repository.updated_at)}</dd></div></dl>
      </article>)}</div><div className="table-scroll desktop-data-table" tabIndex={0} aria-label="Connected repositories"><table className="data-table">
        <thead><tr><th>Repository</th><th>Access</th><th>Default branch</th><th>Last synchronized</th></tr></thead>
        <tbody>{state.repositories.map((repository) => <tr key={repository.id}>
          <td><span className="cell-with-icon"><GitBranchIcon size={17} aria-hidden="true" /><strong className="repo-name">{repository.owner}/{repository.name}</strong></span></td>
          <td><StatusBadge tone={isEnabled(repository.active) ? "success" : "error"}>{isEnabled(repository.active) ? "Connected" : "Access removed"}</StatusBadge></td>
          <td><code>{repository.default_branch ?? "—"}</code></td>
          <td>{formatRelativeTime(repository.updated_at)}</td>
        </tr>)}</tbody>
      </table></div></> : <EmptyState
        icon={GithubLogoIcon}
        title="No repositories connected"
        description="Open the Gardener GitHub App installation and select the repositories you want to automate."
        action={<Button variant="primary" icon={GithubLogoIcon} loading={installMutation.isPending} onClick={() => installMutation.mutate()}>Select repositories</Button>}
      />}
    </Surface>
    <div className="trust-note trust-note--compact"><ShieldCheckIcon size={18} weight="fill" aria-hidden="true" /><div><strong>Scoped GitHub access</strong><p>This Worker receives normalized events and scoped operation receipts. GitHub App credentials remain in Gardener Connect.</p></div></div>
  </>;
}
