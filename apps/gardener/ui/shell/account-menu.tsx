import { CaretDownIcon, GearIcon, GithubLogoIcon, SignOutIcon } from "@phosphor-icons/react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useGardener } from "../app-context";
import { gardenerApi } from "../lib/api";
import { isEnabled } from "../lib/format";
import { cn, DropdownMenu } from "../primitives";
import { useNotifications } from "../providers/notifications";
import { defaultRoute } from "../routes";

const avatarClasses = cn(
  "grid size-7.5 flex-none place-items-center rounded-full",
  "bg-(--color-gardener-accent-wash) text-xs font-semibold",
  "text-(--color-gardener-accent-display)",
);

const identityLabelClasses = cn(
  "grid! grid-cols-[32px_minmax(0,1fr)] items-center gap-2.5",
  "px-2 py-2.5! font-normal!",
);

export function AccountMenu() {
  const { state, session, signOut } = useGardener();
  const { notify } = useNotifications();
  const navigate = useNavigate();
  const repositories =
    state?.repositories.filter((repository) => isEnabled(repository.active)).length ?? 0;

  const installMutation = useMutation({
    mutationFn: gardenerApi.beginInstallation,
    onSuccess: ({ installationUrl }) => {
      location.href = installationUrl;
    },
    onError: (error: Error) =>
      notify({ tone: "error", title: "Unable to open GitHub", description: error.message }),
  });

  if (!session.authenticated) return null;
  const { displayName, role, identity } = session.user;
  const login = identity.login;
  const roleLabel = role === "owner" ? "Owner" : "Member";
  const initial = displayName.slice(0, 1).toUpperCase();

  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        id="account-menu-trigger"
        type="button"
        aria-label={`Open account menu for ${login}`}
        className={cn(
          "group flex h-10 min-h-10 w-full min-w-0 items-center gap-2 rounded-md p-1",
          "group-data-[state=collapsed]/sidebar:justify-center group-data-[state=collapsed]/sidebar:gap-0",
          "border border-transparent text-kumo-default hover:!bg-kumo-base max-[900px]:h-11",
          "aria-expanded:bg-kumo-tint aria-expanded:hover:!bg-kumo-tint",
          "aria-expanded:ring-1 aria-expanded:ring-kumo-line",
        )}
      >
        <span className={avatarClasses} aria-hidden="true">
          {initial}
        </span>
        <span
          className={
            "grid min-w-0 flex-1 justify-items-start leading-tight " +
            "group-data-[state=collapsed]/sidebar:hidden"
          }
        >
          <strong className="max-w-32 truncate text-xs font-semibold">{displayName}</strong>
          <span className="mt-0.5 text-[11px] text-kumo-subtle">{roleLabel}</span>
        </span>
        <CaretDownIcon
          className={
            "ml-auto flex-none text-kumo-subtle transition-transform duration-300 " +
            "ease-[cubic-bezier(0.22,1,0.36,1)] group-aria-expanded:rotate-180 " +
            "group-data-[state=collapsed]/sidebar:hidden"
          }
          size={13}
          aria-hidden="true"
        />
      </DropdownMenu.Trigger>
      <DropdownMenu.Content
        side="top"
        align="start"
        sideOffset={8}
        data-account-menu
        className="z-[260] w-69 p-1.5"
      >
        <DropdownMenu.Group>
          <DropdownMenu.Label className={identityLabelClasses}>
            <span className={avatarClasses} aria-hidden="true">
              {initial}
            </span>
            <span className="grid min-w-0 leading-snug">
              <span className="text-[11px] font-medium text-kumo-subtle">
                {identity.provider === "local" ? "Local development" : "Signed in with GitHub"}
              </span>
              <strong className="mt-0.5 truncate text-[13px] font-semibold text-kumo-strong">
                {displayName}
              </strong>
              <span className="mt-0.5 truncate text-[11px] text-kumo-subtle">
                @{login} · {roleLabel}
              </span>
              {role === "owner" ? (
                <span className="mt-0.5 text-[11px] text-kumo-subtle">
                  {repositories} {repositories === 1 ? "repository" : "repositories"} connected
                </span>
              ) : null}
            </span>
          </DropdownMenu.Label>
        </DropdownMenu.Group>
        <DropdownMenu.Separator />
        {role === "owner" ? (
          <DropdownMenu.Item
            icon={GithubLogoIcon}
            disabled={installMutation.isPending}
            onClick={() => installMutation.mutate()}
          >
            {installMutation.isPending ? "Opening GitHub…" : "Manage GitHub access"}
          </DropdownMenu.Item>
        ) : null}
        <DropdownMenu.Item icon={GearIcon} onClick={() => navigate("/settings")}>
          Dashboard settings
        </DropdownMenu.Item>
        <DropdownMenu.Separator />
        <DropdownMenu.Item
          variant="danger"
          icon={SignOutIcon}
          onClick={() => {
            signOut();
            navigate(defaultRoute, { replace: true });
          }}
        >
          Sign out
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}
