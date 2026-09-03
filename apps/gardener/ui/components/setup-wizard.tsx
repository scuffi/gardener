import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { ArrowRightIcon, CheckIcon, GithubLogoIcon, LockKeyIcon, ShieldCheckIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useGardener } from "../app-context";
import { gardenerApi } from "../lib/api";
import type { SetupProfile } from "../lib/types";
import { useNotifications } from "./notifications";
import { PageHeader, Surface } from "./ui";

const profiles: Array<{ id: SetupProfile; name: string; summary: string; policies: string[]; recommended?: boolean }> = [
  { id: "safe", name: "Safe start", summary: "Labels can run automatically. Comments always wait for your approval.", policies: ["Labels: automatic", "Comments: approval", "Issue state: off"], recommended: true },
  { id: "review", name: "Review everything", summary: "Every proposed label and comment waits for approval before reaching GitHub.", policies: ["Labels: approval", "Comments: approval", "Issue state: off"] },
  { id: "labels", name: "Labels only", summary: "Gardener organizes issues with labels and never posts comments.", policies: ["Labels: automatic", "Comments: off", "Issue state: off"] },
];

export function SetupWizard() {
  const { state, health, refresh } = useGardener();
  const { notify } = useNotifications();
  const repositories = state?.setup.activeRepositories ?? 0;
  const [profile, setProfile] = useState<SetupProfile>(state?.setup.profile ?? "safe");
  const step = repositories === 0 ? 1 : 2;
  const connectReady = Boolean(health?.connectConfigured || health?.localDevelopment);

  const installMutation = useMutation({
    mutationFn: gardenerApi.beginInstallation,
    onSuccess: ({ installationUrl }) => { location.href = installationUrl; },
    onError: (error: Error) => notify({ tone: "error", title: "Unable to open GitHub", description: error.message }),
  });
  const activateMutation = useMutation({
    mutationFn: () => gardenerApi.activate(profile),
    onSuccess: async () => {
      await refresh();
      notify({ tone: "success", title: "Automation active", description: "Gardener is listening for supported issue events." });
    },
    onError: (error: Error) => notify({ tone: "error", title: "Unable to activate Gardener", description: error.message }),
  });

  return <div className="setup-page">
    <PageHeader
      eyebrow="Customer-owned deployment"
      title="Configure repository automation"
      description="Select repository access and decide which actions Gardener can execute. The runtime and audit data stay in your Cloudflare account."
    />

    {!connectReady ? <Banner
      variant="alert"
      icon={<WarningCircleIcon size={20} weight="fill" />}
      title="GitHub connection is not configured"
      description="The Worker is deployed, but Gardener Connect cannot verify this instance. Add a valid GARDENER_INSTANCE_TOKEN and redeploy before continuing."
    /> : null}

    <Surface className="setup-panel" padded={false}>
      <ol className="setup-progress" aria-label="Setup progress">
        {["Select repositories", "Set permissions"].map((label, index) => {
          const number = index + 1;
          const complete = number < step;
          const active = number === step;
          return <li key={label} className={`${complete ? "is-complete" : ""}${active ? " is-active" : ""}`} aria-current={active ? "step" : undefined}>
            <span>{complete ? <CheckIcon size={14} weight="bold" aria-hidden="true" /> : number}</span>
            <div><strong>{label}</strong><small>{complete ? "Complete" : active ? "Current step" : "Not started"}</small></div>
          </li>;
        })}
      </ol>

      <div className="setup-content">
        {step === 1 ? <section className="setup-step-content">
          <div className="setup-icon"><LockKeyIcon size={28} weight="fill" aria-hidden="true" /></div>
          <p className="overline">Step 1 of 2</p>
          <h2>Select repository access</h2>
          <p>Install the shared Gardener GitHub App and choose only the repositories it may observe. You can change access later in GitHub.</p>
          <Button id="setup-primary" data-action="install" variant="primary" size="lg" icon={GithubLogoIcon} loading={installMutation.isPending} onClick={() => installMutation.mutate()}>
            Select repositories
          </Button>
        </section> : null}

        {step === 2 ? <section className="setup-step-content setup-step-content--wide">
          <div className="setup-icon"><ShieldCheckIcon size={28} weight="fill" aria-hidden="true" /></div>
          <p className="overline">Step 2 of 2</p>
          <h2>Choose initial permissions</h2>
          <p>Start with a preset, then adjust each operation from Policies. Closing and reopening issues remain disabled in every preset.</p>
          <fieldset className="profile-grid">
            <legend className="sr-only">Automation permission preset</legend>
            {profiles.map((option) => <label key={option.id} data-profile={option.id} className={`profile-card${profile === option.id ? " profile-card--selected" : ""}`}>
              <input type="radio" name="profile" value={option.id} checked={profile === option.id} onChange={() => setProfile(option.id)} />
              <span className="profile-card__radio" aria-hidden="true" />
              <span className="profile-card__body">
                <span className="profile-card__heading"><strong>{option.name}</strong>{option.recommended ? <em>Recommended</em> : null}</span>
                <span className="profile-card__summary">{option.summary}</span>
                <span className="profile-card__policies">{option.policies.map((policy) => <span key={policy}>{policy}</span>)}</span>
              </span>
            </label>)}
          </fieldset>
          <Button id="setup-primary" data-action="activate" variant="primary" size="lg" icon={ArrowRightIcon} loading={activateMutation.isPending} onClick={() => activateMutation.mutate()}>
            Activate Gardener
          </Button>
        </section> : null}
      </div>
    </Surface>

    <div className="trust-note">
      <ShieldCheckIcon size={20} weight="fill" aria-hidden="true" />
      <div><strong>Credentials stay isolated</strong><p>GitHub credentials remain in Gardener Connect and are never sent to this Worker or Workers AI.</p></div>
    </div>
  </div>;
}
