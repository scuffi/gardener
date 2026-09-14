import {
  ArrowRightIcon,
  CheckIcon,
  GithubLogoIcon,
  LockKeyIcon,
  ShieldCheckIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useGardener } from "../../app-context";
import { gardenerApi } from "../../lib/api";
import type { SetupProfile } from "../../lib/types";
import {
  Badge,
  Banner,
  Button,
  ConfirmDialog,
  PageHeader,
  Panel,
  Radio,
} from "../../primitives";
import { useNotifications } from "../../providers/notifications";

const profiles: Array<{
  id: SetupProfile;
  name: string;
  summary: string;
  policies: string[];
  recommended?: boolean;
}> = [
  {
    id: "safe",
    name: "Safe start",
    summary: "Keep most effects off; require a decision for comments and label removal.",
    policies: [
      "Add labels: automatic",
      "Other labels & comments: approval",
      "All other effects: off",
    ],
    recommended: true,
  },
  {
    id: "review",
    name: "Human review",
    summary: "Require an Inbox decision for every initially supported issue effect.",
    policies: ["Labels: approval", "Comments: approval", "All other effects: off"],
  },
  {
    id: "labels",
    name: "Labels only",
    summary: "Allow label changes while comments and every other persistent effect stay off.",
    policies: ["Labels: automatic", "Comments: off", "All other effects: off"],
  },
];

export function SetupWizard() {
  const { state, health, refresh } = useGardener();
  const { notify } = useNotifications();
  const repositories = state?.setup.activeRepositories ?? 0;
  const [profile, setProfile] = useState<SetupProfile>(state?.setup.profile ?? "safe");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const step = repositories === 0 ? 1 : 2;
  const connectReady = Boolean(health?.connectConfigured || health?.localDevelopment);

  const installMutation = useMutation({
    mutationFn: gardenerApi.beginInstallation,
    onSuccess: ({ installationUrl }) => {
      location.href = installationUrl;
    },
    onError: (error: Error) =>
      notify({
        tone: "error",
        title: "Unable to open GitHub",
        description: error.message,
      }),
  });
  const activateMutation = useMutation({
    mutationFn: () => gardenerApi.activate(profile),
    onSuccess: async () => {
      await refresh();
      setConfirmOpen(false);
      notify({
        tone: "success",
        title: "Setup complete",
        description: "Create, publish, activate, and separately enable an Agent when you are ready.",
      });
    },
    onError: (error: Error) =>
      notify({
        tone: "error",
        title: "Unable to activate Gardener",
        description: error.message,
      }),
  });

  return (
    <div className="mx-auto max-w-[1040px]">
      <PageHeader
        title="Configure Gardener"
        description={
          "Select repository access and set the instance policy ceiling. " +
          "Agents and audit data stay in your Cloudflare account."
        }
      />

      {!connectReady ? (
        <Banner
          className="mb-4"
          variant="alert"
          icon={<WarningCircleIcon size={20} weight="fill" />}
          title="GitHub connection is not configured"
          description={
            "The Worker is deployed, but Gardener Connect cannot verify this instance. " +
            "Add a valid GARDENER_INSTANCE_TOKEN and redeploy before continuing."
          }
        />
      ) : null}

      <Panel className="mb-4" padded={false}>
        <ol
          className="grid list-none grid-cols-2 border-b border-kumo-hairline bg-kumo-elevated p-0"
          aria-label="Setup progress"
        >
          {["Select repositories", "Set permissions"].map((label, index) => {
            const number = index + 1;
            const complete = number < step;
            const active = number === step;
            return (
              <li
                key={label}
                className={[
                  "flex min-w-0 items-center gap-3 px-4 py-4 text-kumo-subtle",
                  index > 0 ? "border-l border-kumo-hairline" : "",
                  active ? "bg-kumo-brand/10" : "",
                ].join(" ")}
                aria-current={active ? "step" : undefined}
              >
                <span
                  className={[
                    "grid size-7 flex-none place-items-center rounded-full border text-xs font-semibold",
                    active ? "border-kumo-brand bg-kumo-brand text-kumo-inverse" : "border-kumo-line bg-kumo-base",
                    complete ? "border-kumo-success bg-kumo-success/10 text-kumo-success" : "",
                  ].join(" ")}
                >
                  {complete ? (
                    <CheckIcon
                      size={14}
                      weight="bold"
                      aria-hidden="true"
                    />
                  ) : number}
                </span>
                <div className="grid min-w-0 max-sm:hidden">
                  <strong className="text-sm font-semibold text-kumo-strong">
                    {label}
                  </strong>
                  <small className="text-xs text-kumo-default">
                    {complete ? "Complete" : active ? "Current step" : "Not started"}
                  </small>
                </div>
              </li>
            );
          })}
        </ol>

        <div className="grid min-h-[360px] place-items-center p-6 sm:p-8">
          {step === 1 ? (
            <section className="w-full max-w-[590px]">
              <div className="mb-4 grid size-11 place-items-center rounded-lg bg-kumo-success/10 text-kumo-success">
                <LockKeyIcon
                  size={28}
                  weight="fill"
                  aria-hidden="true"
                />
              </div>
              <h2 className="text-xl font-semibold text-kumo-strong">Select repository access</h2>
              <p className="mt-2 mb-6 max-w-[650px] text-base leading-relaxed text-kumo-subtle">
                {"Install the shared Gardener GitHub App and choose only the repositories it may observe. " +
                  "You can change access later in GitHub."}
              </p>
              <Button
                id="setup-primary"
                data-action="install"
                variant="primary"
                size="lg"
                icon={GithubLogoIcon}
                loading={installMutation.isPending}
                onClick={() => installMutation.mutate()}
              >
                Select repositories
              </Button>
            </section>
          ) : null}

          {step === 2 ? (
            <section className="w-full max-w-[760px]">
              <div className="mb-4 grid size-11 place-items-center rounded-lg bg-kumo-success/10 text-kumo-success">
                <ShieldCheckIcon
                  size={28}
                  weight="fill"
                  aria-hidden="true"
                />
              </div>
              <h2 className="text-xl font-semibold text-kumo-strong">Choose the initial policy ceiling</h2>
              <p className="mt-2 mb-6 max-w-[650px] text-base leading-relaxed text-kumo-subtle">
                {"These modes constrain every Agent; they do not enable an Agent or grant capabilities. " +
                  "You can review each effect later in Policies."}
              </p>
              <Radio.Group<SetupProfile>
                className="mb-5 gap-3"
                legend="Automation permission preset"
                appearance="card"
                controlPosition="start"
                name="profile"
                value={profile}
                onValueChange={setProfile}
              >
                {profiles.map((option) => (
                  <Radio.Item<SetupProfile>
                    key={option.id}
                    data-profile={option.id}
                    value={option.id}
                    className={
                      "transition-[border-color,box-shadow] duration-300 " +
                      "ease-[cubic-bezier(0.22,1,0.36,1)] hover:border-kumo-line " +
                      "hover:!bg-kumo-base hover:shadow-sm has-[[data-checked]]:hover:!bg-kumo-tint"
                    }
                    label={
                      <span className="flex items-center justify-between gap-3">
                        <strong className="text-base font-semibold text-kumo-strong">{option.name}</strong>
                        {option.recommended ? <Badge variant="primary">Recommended</Badge> : null}
                      </span>
                    }
                    description={
                      <span className="mt-1 grid gap-3">
                        <span className="text-sm leading-relaxed text-kumo-default">{option.summary}</span>
                        <span className="flex flex-wrap gap-1.5">
                          {option.policies.map((policy) => (
                            <Badge key={policy} variant="neutral">
                              {policy}
                            </Badge>
                          ))}
                        </span>
                      </span>
                    }
                  />
                ))}
              </Radio.Group>
              <Button
                id="setup-primary"
                data-action="activate"
                variant="primary"
                size="lg"
                icon={ArrowRightIcon}
                loading={activateMutation.isPending}
                onClick={() => setConfirmOpen(true)}
              >
                Review and finish setup
              </Button>
            </section>
          ) : null}
        </div>
      </Panel>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Apply the ${profiles.find((option) => option.id === profile)?.name ?? profile} profile?`}
        description={
          "Finishing setup applies this policy ceiling and resumes Gardener globally. Agents " +
          "remain disabled until an immutable revision is separately activated and enabled."
        }
        confirmLabel="Apply profile and finish setup"
        loading={activateMutation.isPending}
        onConfirm={() => activateMutation.mutateAsync()}
      />

      <div className="flex items-start gap-3 px-4 py-3 text-kumo-success">
        <ShieldCheckIcon
          size={20}
          weight="fill"
          aria-hidden="true"
        />
        <div className="flex-1">
          <strong className="text-sm font-semibold text-kumo-default">Credentials stay isolated</strong>
          <p className="mt-1 text-sm leading-relaxed text-kumo-subtle">
            {"GitHub credentials remain in Gardener Connect and are never sent to this Worker, the Flue runtime, " +
              "models, or Computer workspaces."}
          </p>
        </div>
      </div>
    </div>
  );
}
