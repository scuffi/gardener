import { TrashIcon, UserPlusIcon, UsersIcon, XIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";
import { useGardener } from "../../../app-context";
import { gardenerApi } from "../../../lib/api";
import { formatDate } from "../../../lib/format";
import { queryKeys } from "../../../lib/query-keys";
import type { TeamInvitation, TeamMember } from "../../../lib/types";
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Input,
  Panel,
  PanelHeader,
  StatusBadge,
  TableSkeleton,
} from "../../../primitives";
import { useNotifications } from "../../../providers/notifications";

type PendingConfirmation =
  | { kind: "revoke"; invitation: TeamInvitation }
  | { kind: "remove"; member: TeamMember };

const githubUsernamePattern = /^(?!.*--)[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

export function TeamPanel() {
  const { session } = useGardener();
  const { notify } = useNotifications();
  const queryClient = useQueryClient();
  const [githubUsername, setGithubUsername] = useState("");
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null);
  const lastConfirmationRef = useRef<PendingConfirmation | null>(null);
  if (confirmation) lastConfirmationRef.current = confirmation;
  const visibleConfirmation = confirmation ?? lastConfirmationRef.current;
  const teamQuery = useQuery({
    queryKey: queryKeys.team,
    queryFn: gardenerApi.team,
    retry: false,
  });
  const isOwner = session.authenticated && session.user.role === "owner";
  const refreshTeam = async () => queryClient.invalidateQueries({ queryKey: queryKeys.team });
  const inviteMutation = useMutation({
    mutationFn: gardenerApi.inviteMember,
    onSuccess: async ({ invitation }) => {
      setGithubUsername("");
      await refreshTeam();
      notify({
        tone: "success",
        title: `Invitation sent to @${invitation.githubUsername}`,
        description: "They can join this Gardener workspace by signing in with GitHub.",
      });
    },
    onError: (error: Error) => {
      notify({
        tone: "error",
        title: "Invitation failed",
        description: error.message,
      });
    },
  });
  const revokeMutation = useMutation({
    mutationFn: gardenerApi.revokeInvitation,
    onSuccess: async () => {
      const login = confirmation?.kind === "revoke" ? confirmation.invitation.username : "user";
      setConfirmation(null);
      await refreshTeam();
      notify({
        tone: "success",
        title: `Invitation for @${login} revoked`,
      });
    },
    onError: (error: Error) => {
      const login = confirmation?.kind === "revoke" ? confirmation.invitation.username : "user";
      notify({
        tone: "error",
        title: `Could not revoke the invitation for @${login}`,
        description: error.message,
      });
    },
  });
  const removeMutation = useMutation({
    mutationFn: gardenerApi.removeMember,
    onSuccess: async () => {
      const login = confirmation?.kind === "remove" ? confirmation.member.username : "user";
      setConfirmation(null);
      await refreshTeam();
      notify({
        tone: "success",
        title: `@${login} removed from the workspace`,
      });
    },
    onError: (error: Error) => {
      const login = confirmation?.kind === "remove" ? confirmation.member.username : "user";
      notify({
        tone: "error",
        title: `Could not remove @${login}`,
        description: error.message,
      });
    },
  });
  const mutationError = inviteMutation.error ?? revokeMutation.error ?? removeMutation.error;
  const normalizedUsername = githubUsername.trim();
  const usernameError =
    normalizedUsername && !githubUsernamePattern.test(normalizedUsername)
      ? "Enter a valid GitHub username using letters, numbers, or single hyphens."
      : undefined;
  const clearMutationErrors = () => {
    inviteMutation.reset();
    revokeMutation.reset();
    removeMutation.reset();
  };

  const submitInvitation = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!normalizedUsername || usernameError || !isOwner) return;
    clearMutationErrors();
    inviteMutation.mutate(normalizedUsername);
  };

  if (teamQuery.isLoading) {
    return (
      <Panel padded={false}>
        <PanelHeader title="Team" description="People who can access this Gardener workspace." />
        <div role="status" aria-label="Loading team">
          <TableSkeleton rows={3} columns={3} />
        </div>
      </Panel>
    );
  }

  if (teamQuery.error) {
    return (
      <Panel padded={false}>
        <PanelHeader title="Team" description="People who can access this Gardener workspace." />
        <div className="p-4">
          <ErrorState
            title="Unable to load the team"
            message={teamQuery.error.message}
            onRetry={() => void teamQuery.refetch()}
          />
        </div>
      </Panel>
    );
  }

  const team = teamQuery.data ?? { members: [], invitations: [] };
  const emptyTeam = team.members.length === 0 && team.invitations.length === 0;

  return (
    <Panel padded={false}>
      <PanelHeader
        title="Team"
        description="The permanent owner, members, and pending GitHub invitations."
      />
      {mutationError ? (
        <div className="px-4 pt-4">
          <ErrorState title="Team change failed" message={mutationError.message} />
        </div>
      ) : null}
      {isOwner ? (
        <form
          className="grid gap-3 border-b border-kumo-hairline px-[18px] py-4 sm:grid-cols-[1fr_auto]"
          onSubmit={submitInvitation}
        >
          <Input
            label="GitHub username"
            description="Enter a GitHub username. Gardener resolves the account before sending an invitation."
            {...(usernameError ? { error: usernameError } : {})}
            placeholder="octocat"
            autoComplete="off"
            maxLength={39}
            value={githubUsername}
            onChange={(event) => setGithubUsername(event.target.value)}
          />
          <Button
            type="submit"
            variant="primary"
            icon={UserPlusIcon}
            loading={inviteMutation.isPending}
            disabled={!normalizedUsername || Boolean(usernameError) || inviteMutation.isPending}
            className="min-h-11 self-end max-sm:w-full"
          >
            Invite GitHub user
          </Button>
        </form>
      ) : null}
      {emptyTeam ? (
        <EmptyState
          compact
          icon={UsersIcon}
          title="No team members reported"
          description="Members and pending GitHub invitations will appear here when available."
        />
      ) : null}
      {team.members.length ? (
        <section aria-labelledby="team-members-heading">
          <h3
            id="team-members-heading"
            className="border-b border-kumo-hairline px-[18px] py-2 text-xs font-semibold text-kumo-subtle"
          >
            Members
          </h3>
          <ul className="m-0 list-none p-0">
            {team.members.map((member) => {
            const roleLabel = member.role === "owner" ? "Owner" : "Member";
            return (
              <li
                key={member.id}
                className={
                  "flex min-h-15 items-center gap-3 border-b border-kumo-hairline px-[18px] py-2.5 " +
                  "last:border-b-0 max-[480px]:items-start"
                }
              >
                <div className="min-w-0 flex-1">
                  <strong className="block truncate text-sm text-kumo-strong">
                    {member.display_name}
                  </strong>
                  <span className="block truncate text-xs text-kumo-subtle">@{member.username}</span>
                  {member.role === "owner" && member.permanent ? (
                    <span className="block text-xs text-kumo-subtle">Permanent access</span>
                  ) : null}
                </div>
                <StatusBadge tone="neutral">{roleLabel}</StatusBadge>
                {isOwner && member.role === "member" && !member.permanent ? (
                  <Button
                    type="button"
                    variant="secondary-destructive"
                    icon={TrashIcon}
                    className="min-h-11 max-[480px]:px-2"
                    onClick={() => {
                      clearMutationErrors();
                      setConfirmation({ kind: "remove", member });
                    }}
                  >
                    Remove <span className="max-[480px]:sr-only">@{member.username}</span>
                  </Button>
                ) : null}
              </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {team.invitations.length ? (
        <section aria-labelledby="team-invitations-heading">
          <h3
            id="team-invitations-heading"
            className="border-y border-kumo-hairline px-[18px] py-2 text-xs font-semibold text-kumo-subtle"
          >
            Pending invitations
          </h3>
          <ul className="m-0 list-none p-0">
            {team.invitations.map((invitation) => (
              <li
                key={invitation.id}
                className={
                  "flex min-h-15 items-center gap-3 border-b border-kumo-hairline px-[18px] py-2.5 " +
                  "last:border-b-0 max-[480px]:items-start"
                }
              >
                <div className="min-w-0 flex-1">
                  <strong className="block truncate text-sm text-kumo-strong">
                    @{invitation.username}
                  </strong>
                  <span className="block text-xs text-kumo-subtle">Member</span>
                  <span className="block text-xs text-kumo-subtle">
                    Expires {formatDate(invitation.expires_at)}
                  </span>
                </div>
                <StatusBadge tone="warning">Pending</StatusBadge>
                {isOwner ? (
                  <Button
                    type="button"
                    variant="secondary-destructive"
                    icon={XIcon}
                    className="min-h-11 max-[480px]:px-2"
                    onClick={() => {
                      clearMutationErrors();
                      setConfirmation({ kind: "revoke", invitation });
                    }}
                  >
                    Revoke <span className="max-[480px]:sr-only">@{invitation.username}</span>
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {visibleConfirmation ? (
        <ConfirmDialog
          open={confirmation !== null}
          onOpenChange={(open) => {
            if (!open && !revokeMutation.isPending && !removeMutation.isPending) {
              setConfirmation(null);
            }
          }}
          title={
            visibleConfirmation.kind === "remove"
              ? `Remove @${visibleConfirmation.member.username} from the team?`
              : `Revoke the invitation for @${visibleConfirmation.invitation.username}?`
          }
          description={
            visibleConfirmation.kind === "remove"
              ? `@${visibleConfirmation.member.username} will immediately lose access to this Gardener workspace.`
              : `@${visibleConfirmation.invitation.username} will no longer be able to join with this invitation.`
          }
          confirmLabel={
            visibleConfirmation.kind === "remove"
              ? `Remove @${visibleConfirmation.member.username}`
              : `Revoke invitation for @${visibleConfirmation.invitation.username}`
          }
          confirmTone="destructive"
          loading={revokeMutation.isPending || removeMutation.isPending}
          onConfirm={async () => {
            const activeConfirmation = confirmation;
            if (activeConfirmation?.kind === "revoke") {
              await revokeMutation.mutateAsync(activeConfirmation.invitation.id);
            } else if (activeConfirmation?.kind === "remove") {
              await removeMutation.mutateAsync(activeConfirmation.member.id);
            }
          }}
        />
      ) : null}
    </Panel>
  );
}
