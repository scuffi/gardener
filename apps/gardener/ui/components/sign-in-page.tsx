import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { GithubLogoIcon, ShieldCheckIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useGardener } from "../app-context";
import { PageHeader, Surface } from "./ui";

export function SignInPage() {
  const { health } = useGardener();
  const connectReady = Boolean(health?.connectConfigured || health?.localDevelopment);

  return <div className="setup-page">
    <div className="auth-layout">
      <PageHeader
        title="Sign in to Gardener"
        description="Manage repositories, policies, approvals, and automation for this deployment."
      />

      {!connectReady ? <Banner
        variant="alert"
        icon={<WarningCircleIcon size={20} weight="fill" />}
        title="Dashboard sign-in is not configured"
        description="Add a valid GARDENER_INSTANCE_TOKEN to this Worker and redeploy before signing in."
      /> : null}

      <Surface className="auth-panel" padded={false}>
        <section className="auth-content">
          <div className="setup-icon"><GithubLogoIcon size={28} weight="fill" aria-hidden="true" /></div>
          <h2>Welcome back</h2>
          <p>Sign in with the GitHub account that owns this Gardener deployment. Repository access is configured separately after sign-in.</p>
          <Button
            id="setup-primary"
            data-action="signin"
            variant="primary"
            size="lg"
            icon={GithubLogoIcon}
            disabled={!connectReady}
            onClick={() => { location.href = "/api/auth/start"; }}
          >Sign in with GitHub</Button>
          <p className="field-note">Only the GitHub account bound to this deployment can open its dashboard.</p>
        </section>
      </Surface>

      <div className="trust-note auth-trust">
        <ShieldCheckIcon size={20} weight="fill" aria-hidden="true" />
        <div><strong>Repository credentials stay isolated</strong><p>GitHub App credentials remain in Gardener Connect and are never sent to this Worker or Workers AI.</p></div>
      </div>
    </div>
  </div>;
}
