import {
  ArrowClockwiseIcon,
  GithubLogoIcon,
  GitBranchIcon,
  ShieldCheckIcon,
} from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useGardener } from "../../app-context";
import { gardenerApi } from "../../lib/api";
import { formatRelativeTime, isEnabled, sentenceCase } from "../../lib/format";
import { queryPrefixes } from "../../lib/query-keys";
import { useNotifications } from "../../providers/notifications";
import {
  Button,
  EmptyState,
  ErrorState,
  Mono,
  PageHeader,
  Panel,
  StatusBadge,
  statusTone,
  Table,
  TableSkeleton,
  Text,
} from "../../primitives";

export function RepositoriesPage() {
  const { state, stateLoading, error, refresh } = useGardener();
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
      await queryClient.invalidateQueries({ queryKey: queryPrefixes.state });
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
    return (
      <>
        <PageHeader
          title="Repositories"
          description={
            "Choose where Gardener may observe events and propose or execute actions. " +
            "Repository access remains controlled by the GitHub App installation."
          }
        />
        <Panel padded={false}>
          {stateLoading ? (
            <TableSkeleton columns={4} />
          ) : error ? (
            <div className="p-4">
              <ErrorState message={error.message} onRetry={() => void refresh()} />
            </div>
          ) : (
            <EmptyState
              icon={GithubLogoIcon}
              title="No repository data available"
              description="Connect the Gardener GitHub App to load repository access for this workspace."
              action={
                <Button
                  variant="primary"
                  icon={GithubLogoIcon}
                  loading={installMutation.isPending}
                  onClick={() => installMutation.mutate()}
                >
                  Connect GitHub
                </Button>
              }
            />
          )}
        </Panel>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Repositories"
        description={
          "Choose where Gardener may observe events and propose or execute actions. " +
          "Repository access remains controlled by the GitHub App installation."
        }
        actions={
          <Button
            variant="secondary"
            icon={ArrowClockwiseIcon}
            loading={syncMutation.isPending}
            onClick={() => syncMutation.mutate()}
          >
            Sync access
          </Button>
        }
      />
      <Panel padded={false}>
        {state.repositories.length ? (
          <div
            className="w-full max-w-full overflow-x-auto overscroll-x-contain"
            tabIndex={0}
            aria-label="Connected repositories"
          >
            <Table layout="auto" className="min-w-[680px]">
              <Table.Header variant="compact">
                <Table.Row>
                  <Table.Head sticky="left">Repository</Table.Head>
                  <Table.Head>Access</Table.Head>
                  <Table.Head>Default branch</Table.Head>
                  <Table.Head>Last synchronized</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {state.repositories.map((repository) => {
                  const accessRemoved = !isEnabled(repository.active);
                  const status = accessRemoved
                    ? "access_removed"
                    : repository.paused
                      ? "paused"
                      : "connected";
                  return (
                    <Table.Row key={repository.id} data-repository-id={repository.id}>
                      <Table.Cell sticky="left">
                        <div className="flex min-w-52 items-center gap-2.5">
                          <GitBranchIcon
                            size={17}
                            className="flex-none text-kumo-subtle"
                            aria-hidden="true"
                          />
                          <div className="min-w-0">
                            <strong className="block font-medium text-kumo-strong">
                              {repository.owner}/{repository.name}
                            </strong>
                            <Mono truncate title={repository.id}>
                              {repository.id}
                            </Mono>
                          </div>
                        </div>
                      </Table.Cell>
                      <Table.Cell>
                        <StatusBadge tone={statusTone(status)}>{sentenceCase(status)}</StatusBadge>
                      </Table.Cell>
                      <Table.Cell>
                        <Mono tone="default">{repository.default_branch ?? "—"}</Mono>
                      </Table.Cell>
                      <Table.Cell className="whitespace-nowrap text-kumo-subtle">
                        {formatRelativeTime(repository.updated_at)}
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table>
          </div>
        ) : (
          <EmptyState
            icon={GithubLogoIcon}
            title="No repositories connected"
            description={
              "Open the Gardener GitHub App installation and select the repositories you want to automate."
            }
            action={
              <Button
                variant="primary"
                icon={GithubLogoIcon}
                loading={installMutation.isPending}
                onClick={() => installMutation.mutate()}
              >
                Select repositories
              </Button>
            }
          />
        )}
      </Panel>
      <Panel className="mt-4 flex items-start gap-2.5 py-3">
        <ShieldCheckIcon
          size={18}
          weight="fill"
          className="flex-none text-kumo-success"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <Text
            bold
            size="xs"
            DANGEROUS_className="text-kumo-strong"
          >
            Scoped GitHub access
          </Text>
          <Text
            size="xs"
            variant="secondary"
            DANGEROUS_className="mt-0.5 leading-relaxed"
          >
            This Worker receives normalized events and scoped operation receipts. GitHub App credentials remain
            in Gardener Connect.
          </Text>
        </div>
      </Panel>
    </>
  );
}
