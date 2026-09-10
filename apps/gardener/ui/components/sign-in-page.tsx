import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { GithubLogoIcon, PlantIcon, ShieldCheckIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useGardener } from "../app-context";
import { ThemeToggle } from "../theme";
import { AsciiGarden } from "./ascii-garden";
import { LoadingState, Surface } from "./ui";

export function SignInPage() {
  const { health, loading, error, refresh } = useGardener();
  const connectReady = Boolean(health?.connectConfigured || health?.localDevelopment);
  const unavailable = Boolean(error && !health);

  return <div className="signin-stage">
    <a className="skip-link" href="#main-content">Skip to sign in</a>
    <header className="signin-header">
      <div className="signin-brand" aria-label="Gardener repository stewardship">
        <span className="signin-brand__mark"><PlantIcon size={20} weight="bold" aria-hidden="true" /></span>
        <span className="signin-brand__copy"><strong>Gardener</strong><small>Repository stewardship</small></span>
      </div>
      <ThemeToggle />
    </header>

    <main id="main-content" className="signin-main">
      <div className="signin-hero">
        <Surface className="signin-card auth-panel" padded={false}>
          <section className="auth-content" aria-labelledby="signin-heading">
            {loading ? <>
              <div className="signin-card__topline">
                <span className="signin-card__icon"><PlantIcon size={20} weight="fill" aria-hidden="true" /></span>
                <code>INSTANCE_HANDSHAKE</code>
              </div>
              <h1 id="signin-heading">Opening Gardener</h1>
              <p>Checking this deployment and preparing a secure sign-in.</p>
              <div className="signin-card__loading"><LoadingState label="Checking deployment" /></div>
            </> : unavailable ? <div className="signin-card__state" role="alert">
              <div className="signin-card__topline">
                <span className="signin-card__icon signin-card__icon--warning"><WarningCircleIcon size={20} weight="fill" aria-hidden="true" /></span>
                <code>CONNECTION_ERROR</code>
              </div>
              <h1 id="signin-heading">Unable to reach Gardener</h1>
              <p>{error?.message ?? "This deployment did not respond."}</p>
              <Button className="signin-card__button" variant="secondary" size="lg" onClick={() => void refresh()}>Try again</Button>
            </div> : <>
              <div className="signin-card__topline">
                <span className="signin-card__icon"><GithubLogoIcon size={20} weight="fill" aria-hidden="true" /></span>
                <code>OWNER_ACCESS</code>
              </div>
              <h1 id="signin-heading">Welcome back</h1>
              <p id="signin-description">Sign in with the owner account to tend this Gardener deployment.</p>

              {!connectReady ? <Banner
                variant="alert"
                icon={<WarningCircleIcon size={20} weight="fill" />}
                title="Dashboard sign-in is not configured"
                description="Add a valid GARDENER_INSTANCE_TOKEN to this Worker and redeploy before signing in."
              /> : null}

              <Button
                id="setup-primary"
                data-action="signin"
                className="signin-card__button"
                variant="primary"
                size="lg"
                icon={GithubLogoIcon}
                disabled={!connectReady}
                aria-describedby="signin-description signin-owner-note"
                onClick={() => { location.href = "/api/auth/start"; }}
              >Sign in with GitHub</Button>
              <p id="signin-owner-note" className="signin-owner-note">Only the GitHub account bound to this deployment can continue.</p>

              <div className="signin-security">
                <ShieldCheckIcon size={18} weight="fill" aria-hidden="true" />
                <p><strong>Credentials stay isolated.</strong> Repository access is managed separately through Gardener Connect.</p>
              </div>
            </>}
          </section>
        </Surface>
      </div>
    </main>

    <AsciiGarden />
    <div className="signin-horizon" aria-hidden="true" />
  </div>;
}
