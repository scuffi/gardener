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
  "bg-kumo-brand/10 text-xs font-semibold text-kumo-brand",
);

const identityLabelClasses = cn(
  "grid! grid-cols-[32px_minmax(0,1fr)] items-center gap-2.5",
  "px-2 py-2.5! font-normal!",
);

export function AccountMenu() {
  const { state, signOut } = useGardener();
  const { notify } = useNotifications();
  const navigate = useNavigate();
  const login = state?.viewer.login;
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

  if (!login) return null;
  const initial = login.slice(0, 1).toUpperCase();

  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        id="account-menu-trigger"
        type="button"
        aria-label={`Open account menu for ${login}`}
        className={cn(
          "flex h-10 min-h-10 w-full min-w-0 items-center gap-2 rounded-md p-1",
          "border border-transparent text-kumo-default hover:bg-kumo-tint",
          "aria-expanded:bg-kumo-tint aria-expanded:ring-1 aria-expanded:ring-kumo-line",
        )}
      >
        <span className={avatarClasses} aria-hidden="true">
          {initial}
        </span>
        <span className="grid min-w-0 flex-1 justify-items-start leading-tight">
          <strong className="max-w-32 truncate text-xs font-semibold">{login}</strong>
          <span className="mt-0.5 text-[11px] text-kumo-subtle">GitHub connected</span>
        </span>
        <CaretDownIcon className="ml-auto flex-none text-kumo-subtle" size={13} aria-hidden="true" />
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
              <span className="text-[11px] font-medium text-kumo-subtle">Signed in with GitHub</span>
              <strong className="mt-0.5 truncate text-[13px] font-semibold text-kumo-strong">
                {login}
              </strong>
              <span className="mt-0.5 text-[11px] text-kumo-subtle">
                {repositories} {repositories === 1 ? "repository" : "repositories"} connected
              </span>
            </span>
          </DropdownMenu.Label>
        </DropdownMenu.Group>
        <DropdownMenu.Separator />
        <DropdownMenu.Item
          icon={GithubLogoIcon}
          disabled={installMutation.isPending}
          onClick={() => installMutation.mutate()}
        >
          {installMutation.isPending ? "Opening GitHub…" : "Manage GitHub access"}
        </DropdownMenu.Item>
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
