import { GithubLogoIcon, PlantIcon, ShieldCheckIcon, WarningCircleIcon } from "@phosphor-icons/react";
import type { CSSProperties } from "react";
import { useGardener } from "../../app-context";
import { Banner, Button, LoadingState, Panel, PoweredByCloudflare } from "../../primitives";
import { SkipLink } from "../../shell/skip-link";
import { ThemeToggle } from "../../theme";

const brandRingStyle: CSSProperties = {
  background: [
    "linear-gradient(var(--color-kumo-base), var(--color-kumo-base)) padding-box,",
    "conic-gradient(from var(--brand-ring-angle), var(--color-kumo-line) 0 34%,",
    "var(--color-kumo-brand) 47%, var(--color-kumo-line) 60% 100%) border-box",
  ].join(" "),
  animation: "brand-ring-orbit 7s linear infinite",
};

export function SignInPage() {
  const { health, loading, error, refresh } = useGardener();
  const connectReady = Boolean(health?.connectConfigured || health?.localDevelopment);
  const unavailable = Boolean(error && !health);

  return (
    <div className="grid min-h-svh grid-rows-[auto_1fr] bg-kumo-canvas text-kumo-default">
      <SkipLink href="#main-content">Skip to sign in</SkipLink>
      <header className="flex w-full items-center justify-between px-5 py-5 sm:px-10 lg:px-14">
        <div className="inline-flex items-center gap-3" aria-label="Gardener repository stewardship">
          <span className="grid size-9 place-items-center rounded-lg bg-kumo-success/10 text-kumo-success">
            <PlantIcon
              size={20}
              weight="bold"
              aria-hidden="true"
            />
          </span>
          <span className="grid leading-tight">
            <strong className="text-sm font-semibold text-kumo-strong">Gardener</strong>
            <small className="mt-1 text-xs text-kumo-subtle">Repository stewardship</small>
          </span>
        </div>
        <ThemeToggle />
      </header>

      <main id="main-content" className="grid place-items-center px-4 py-10 sm:px-6 sm:py-16">
        <div className="w-full max-w-[430px]">
          <div className="rounded-xl border border-transparent shadow-lg" style={brandRingStyle}>
            <Panel className="rounded-[11px]" padded={false}>
              <section className="p-6 sm:p-8" aria-labelledby="signin-heading">
                {loading ? (
                  <>
                    <div className="mb-6 flex items-center justify-between gap-5">
                      <span className="grid size-9 place-items-center rounded-lg bg-kumo-elevated">
                        <PlantIcon
                          size={20}
                          weight="fill"
                          aria-hidden="true"
                        />
                      </span>
                      <code className="text-xs font-semibold tracking-widest text-kumo-subtle">
                        INSTANCE_HANDSHAKE
                      </code>
                    </div>
                    <h1 id="signin-heading" className="text-3xl font-semibold tracking-tight text-kumo-strong">
                      Opening Gardener
                    </h1>
                    <p className="mt-2 text-base leading-relaxed text-kumo-subtle">
                      Checking this deployment and preparing a secure sign-in.
                    </p>
                    <div className="mt-5 rounded-lg border border-kumo-hairline bg-kumo-recessed">
                      <LoadingState label="Checking deployment" />
                    </div>
                  </>
                ) : unavailable ? (
                  <div role="alert">
                    <div className="mb-6 flex items-center justify-between gap-5">
                      <span className="grid size-9 place-items-center rounded-lg bg-kumo-warning/10 text-kumo-warning">
                        <WarningCircleIcon
                          size={20}
                          weight="fill"
                          aria-hidden="true"
                        />
                      </span>
                      <code className="text-xs font-semibold tracking-widest text-kumo-subtle">
                        CONNECTION_ERROR
                      </code>
                    </div>
                    <h1 id="signin-heading" className="text-3xl font-semibold tracking-tight text-kumo-strong">
                      Unable to reach Gardener
                    </h1>
                    <p className="mt-2 text-base leading-relaxed text-kumo-subtle">
                      {error?.message ?? "This deployment did not respond."}
                    </p>
                    <Button
                      className="mt-6 w-full justify-center"
                      variant="secondary"
                      size="lg"
                      onClick={() => void refresh()}
                    >
                      Try again
                    </Button>
                  </div>
                ) : (
                  <>
                    <div className="mb-6 flex items-center justify-between gap-5">
                      <span className="grid size-9 place-items-center rounded-lg bg-kumo-elevated">
                        <GithubLogoIcon
                          size={20}
                          weight="fill"
                          aria-hidden="true"
                        />
                      </span>
                      <code className="text-xs font-semibold tracking-widest text-kumo-subtle">OWNER_ACCESS</code>
                    </div>
                    <h1 id="signin-heading" className="text-3xl font-semibold tracking-tight text-kumo-strong">
                      Welcome back
                    </h1>
                    <p id="signin-description" className="mt-2 text-base leading-relaxed text-kumo-subtle">
                      Sign in with the owner account to tend this Gardener deployment.
                    </p>

                    {!connectReady ? (
                      <Banner
                        className="mt-5"
                        variant="alert"
                        icon={<WarningCircleIcon size={20} weight="fill" />}
                        title="Dashboard sign-in is not configured"
                        description={
                          "Add a valid GARDENER_INSTANCE_TOKEN to this Worker and redeploy before signing in."
                        }
                      />
                    ) : null}

                    <Button
                      id="setup-primary"
                      data-action="signin"
                      className="mt-6 w-full justify-center"
                      variant="primary"
                      size="lg"
                      icon={GithubLogoIcon}
                      disabled={!connectReady}
                      aria-describedby="signin-description signin-owner-note"
                      onClick={() => {
                        location.href = "/api/auth/start";
                      }}
                    >
                      Sign in with GitHub
                    </Button>
                    <p id="signin-owner-note" className="mt-3 text-center text-xs leading-relaxed text-kumo-subtle">
                      Only the GitHub account bound to this deployment can continue.
                    </p>

                    <div className="mt-6 grid grid-cols-[18px_1fr] gap-3 border-t border-kumo-hairline pt-5">
                      <ShieldCheckIcon
                        className="text-kumo-success"
                        size={18}
                        weight="fill"
                        aria-hidden="true"
                      />
                      <p className="text-xs leading-relaxed text-kumo-subtle">
                        <strong className="font-semibold text-kumo-default">Credentials stay isolated.</strong>{" "}
                        Repository access is managed separately through Gardener Connect.
                      </p>
                    </div>
                  </>
                )}
              </section>
            </Panel>
          </div>
          <footer className="mt-6 flex justify-center">
            <PoweredByCloudflare />
          </footer>
        </div>
      </main>
    </div>
  );
}
