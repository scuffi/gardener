import { DropdownMenu } from "@cloudflare/kumo/components/dropdown";
import { CaretDownIcon, GearIcon, GithubLogoIcon, SignOutIcon } from "@phosphor-icons/react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useGardener } from "../app-context";
import { gardenerApi } from "../lib/api";
import { isEnabled } from "../lib/format";
import { useNotifications } from "./notifications";

export function AccountMenu() {
  const { state, signOut } = useGardener();
  const { notify } = useNotifications();
  const navigate = useNavigate();
  const login = state?.viewer.login;
  const repositories = state?.repositories.filter((repository) => isEnabled(repository.active)).length ?? 0;
  const installMutation = useMutation({
    mutationFn: gardenerApi.beginInstallation,
    onSuccess: ({ installationUrl }) => { location.href = installationUrl; },
    onError: (error: Error) => notify({ tone: "error", title: "Unable to open GitHub", description: error.message }),
  });
  if (!login) return null;

  return <DropdownMenu>
    <DropdownMenu.Trigger
      id="account-menu-trigger"
      type="button"
      className="account-menu-trigger account-menu-trigger--sidebar"
      aria-label={`Open account menu for ${login}`}
    >
      <span className="account-avatar" aria-hidden="true">{login.slice(0, 1).toUpperCase()}</span>
      <span className="account-menu-trigger__copy"><strong>{login}</strong><small>GitHub connected</small></span>
      <CaretDownIcon className="account-menu-trigger__caret" size={13} aria-hidden="true" />
    </DropdownMenu.Trigger>
    <DropdownMenu.Content side="top" align="start" sideOffset={8} className="account-menu-content" data-account-menu>
      <DropdownMenu.Group>
        <DropdownMenu.Label className="account-menu-identity">
          <span className="account-avatar" aria-hidden="true">{login.slice(0, 1).toUpperCase()}</span>
          <span><small>Signed in with GitHub</small><strong>{login}</strong><em>{repositories} {repositories === 1 ? "repository" : "repositories"} connected</em></span>
        </DropdownMenu.Label>
      </DropdownMenu.Group>
      <DropdownMenu.Separator />
      <DropdownMenu.Item icon={GithubLogoIcon} disabled={installMutation.isPending} onClick={() => installMutation.mutate()}>
        {installMutation.isPending ? "Opening GitHub…" : "Manage GitHub access"}
      </DropdownMenu.Item>
      <DropdownMenu.Item icon={GearIcon} onClick={() => navigate("/settings")}>
        Dashboard settings
      </DropdownMenu.Item>
      <DropdownMenu.Separator />
      <DropdownMenu.Item variant="danger" icon={SignOutIcon} onClick={() => { signOut(); navigate("/overview", { replace: true }); }}>
        Sign out
      </DropdownMenu.Item>
    </DropdownMenu.Content>
  </DropdownMenu>;
}
