import { ArrowClockwiseIcon, GithubLogoIcon, ShieldCheckIcon } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useGardener } from "../../app-context";
import { gardenerApi } from "../../lib/api";
import { queryPrefixes } from "../../lib/query-keys";
import { useNotifications } from "../../providers/notifications";
import {
  Button,
  EmptyState,
  ErrorState,
  PageHeader,
  PageHeaderSkeleton,
  Panel,
  TableSkeleton,
} from "../../primitives";
import { RepositoryCard } from "./components/repository-card";

export function RepositoriesPage() {
  const { state, stateLoading, error, refresh, session } = useGardener();
  const role = session?.authenticated ? session.user.role : "member";
  const owner = role === "owner";
  const queryClient = useQueryClient();
  const { notify } = useNotifications();
  const installMutation = useMutation({
    mutationFn: gardenerApi.beginInstallation,
    onSuccess: ({ installationUrl }) => {
      location.href = installationUrl;
    },
    onError: (mutationError: Error) =>
      notify({
        tone: "error",
        title: "Unable to open GitHub",
        description: mutationError.message,
      }),
  });
  const syncMutation = useMutation({
    mutationFn: gardenerApi.syncRepositories,
    onSuccess: async ({ repositories }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryPrefixes.state }),
        queryClient.invalidateQueries({ queryKey: queryPrefixes.repositories }),
      ]);
      notify({
        tone: "success",
        title: "Repository access synchronized",
        description: `${repositories.length} ${
          repositories.length === 1 ? "repository" : "repositories"
        } returned by GitHub.`,
      });
    },
    onError: (mutationError: Error) =>
      notify({
        tone: "error",
        title: "Repository sync failed",
        description: mutationError.message,
      }),
  });

  if (!state) {
    if (stateLoading) {
      return (
        <>
          <PageHeaderSkeleton />
          <Panel padded={false}>
            <TableSkeleton rows={4} columns={3} />
          </Panel>
        </>
      );
    }
    return (
      <>
        <PageHeader
          title="Repositories"
          description="See where Agents are assigned and the exact policy that bounds each repository."
        />
        {error ? (
          <ErrorState message={error.message} onRetry={() => void refresh()} />
        ) : (
          <Panel>
            <EmptyState
              icon={GithubLogoIcon}
              title="No repository data available"
              description="Connect the Gardener GitHub App to load repositories for this workspace."
              action={
                owner ? (
                  <Button
                    variant="primary"
                    icon={GithubLogoIcon}
                    loading={installMutation.isPending}
                    className="max-sm:min-h-11"
                    onClick={() => installMutation.mutate()}
                  >
                    Connect GitHub
                  </Button>
                ) : undefined
              }
            />
          </Panel>
        )}
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Repositories"
        description="See where Agents are assigned and the exact policy that bounds each repository."
        actions={
          owner ? (
            <Button
              variant="secondary"
              icon={ArrowClockwiseIcon}
              loading={syncMutation.isPending}
              className="max-sm:min-h-11"
              onClick={() => syncMutation.mutate()}
            >
              Sync access
            </Button>
          ) : undefined
        }
      />
      {state.repositories.length ? (
        <div className="grid gap-4">
          {state.repositories.map((repository) => (
            <RepositoryCard
              key={repository.id}
              repository={repository}
              role={role}
              onManageInstallation={() => installMutation.mutate()}
            />
          ))}
        </div>
      ) : (
        <Panel>
          <EmptyState
            icon={GithubLogoIcon}
            title="No repositories connected"
            description={
              owner
                ? "Select repositories in the Gardener GitHub App installation to manage them here."
                : "The workspace Owner has not connected any repositories yet."
            }
            action={
              owner ? (
                <Button
                  variant="primary"
                  icon={GithubLogoIcon}
                  loading={installMutation.isPending}
                  className="max-sm:min-h-11"
                  onClick={() => installMutation.mutate()}
                >
                  Select repositories
                </Button>
              ) : undefined
            }
          />
        </Panel>
      )}
      <Panel className="mt-4 flex items-start gap-2.5 py-3">
        <ShieldCheckIcon
          size={18}
          weight="fill"
          className="flex-none text-kumo-success"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-kumo-strong">Repository-centric authority</p>
          <p className="mt-0.5 text-xs leading-relaxed text-kumo-subtle">
            Assignments show which Agents may run. Repository policy and workspace ceilings decide
            the effective authority available to each run.
          </p>
        </div>
      </Panel>
    </>
  );
}
