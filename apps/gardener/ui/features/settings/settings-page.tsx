import {
  CpuIcon,
  DatabaseIcon,
  GithubLogoIcon,
  HardDrivesIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { useGardener } from "../../app-context";
import { sentenceCase } from "../../lib/format";
import {
  Banner,
  EmptyState,
  ErrorState,
  Grid,
  GridItem,
  Mono,
  PageHeader,
  PageHeaderSkeleton,
  Panel,
  PanelHeader,
  StatusBadge,
  TableSkeleton,
} from "../../primitives";
import { AccentPicker, ThemePicker } from "../../theme";

export function SettingsPage() {
  const { state, health, error, refresh } = useGardener();

  // A failed load must not sit on a skeleton forever; offer the same recovery as Overview.
  if (error && (!state || !health)) {
    return (
      <>
        <PageHeader
          title="Settings"
          description="Inspect this instance's deployment health and runtime boundaries."
        />
        <ErrorState
          message={error.message || "Gardener could not load this deployment."}
          onRetry={() => void refresh()}
        />
      </>
    );
  }

  // Shared health/state is still in flight. Render the shape of the page rather than a blank
  // screen, so the layout does not jump when the data lands.
  if (!state || !health) {
    return (
      <>
        <PageHeaderSkeleton />
        <Panel padded={false}>
          <TableSkeleton rows={4} columns={2} />
        </Panel>
      </>
    );
  }

  const services = [
    {
      name: "D1 database",
      description: "Agents, decisions, runs, effects, and audit records",
      ready: health.database,
      icon: DatabaseIcon,
    },
    {
      name: "Durable orchestration",
      description:
        `Run continuation, retries, waits, and cancellation · ` +
        sentenceCase(health.agentRuntime.status),
      ready: health.agentRuntime.enabled,
      icon: HardDrivesIcon,
    },
    {
      name: "Flue + Cloudflare AI",
      description: "Flue Agent runtime through the Cloudflare AI binding",
      ready: health.workersAi,
      icon: CpuIcon,
    },
    {
      name: "Gardener Connect",
      description: "GitHub identity, installation access, and writes",
      ready: health.connectConfigured,
      icon: GithubLogoIcon,
    },
  ];

  return (
    <>
      <PageHeader
        title="Settings"
        description={
          "Inspect this instance's Cloudflare services, Flue runtime, workspace availability, " +
          "and runtime limits."
        }
      />
      <div className="grid gap-4">
        {!health.ok ? (
          <Banner
            variant="error"
            icon={<WarningCircleIcon size={20} weight="fill" />}
            title="Agent execution is fail closed"
            description={
              "One or more required services are unavailable. New runs and persistent effects " +
              "remain fail closed until the deployment recovers."
            }
          />
        ) : null}

        <Panel padded={false}>
          <PanelHeader
            title="Deployment health"
            description="Required services for this customer-owned Gardener instance."
          />
          <div className="grid">
            {services.map((service) => (
              <div
                key={service.name}
                className={
                  "grid min-h-[62px] grid-cols-[34px_minmax(0,1fr)_auto] items-center gap-3 " +
                  "border-b border-kumo-hairline px-[18px] py-2.5 last:border-b-0 hover:bg-kumo-tint " +
                  "max-[480px]:grid-cols-[32px_minmax(0,1fr)]"
                }
              >
                <span
                  className={
                    "grid size-8 place-items-center rounded-md border border-kumo-hairline " +
                    "bg-kumo-elevated text-kumo-subtle"
                  }
                >
                  <service.icon size={19} aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <strong className="text-sm text-kumo-strong">{service.name}</strong>
                  <p className="text-xs text-kumo-subtle">{service.description}</p>
                </div>
                <div className="max-[480px]:col-start-2 max-[480px]:justify-self-start">
                  <StatusBadge tone={service.ready ? "success" : "danger"}>
                    {service.ready ? "Ready" : "Unavailable"}
                  </StatusBadge>
                </div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel padded={false}>
          <PanelHeader
            title="Appearance"
            description="Choose how this Gardener workspace looks on this device."
          />
          <ThemePicker />
          <div className="border-t border-kumo-hairline">
            <PanelHeader
              title="Accent"
              description="Cloudflare orange, or green to match the gardening metaphor."
            />
            <AccentPicker />
          </div>
        </Panel>

        <Grid variant="2up" gap="base">
          <GridItem>
            <Panel padded={false} className="h-full">
              <PanelHeader
                title="Cloudflare AI binding"
                description={
                  "Send synthetic data through the configured model without granting tools or " +
                  "repository authority."
                }
              />
              <dl className="grid px-4 pb-[18px] pt-2">
                <div className="flex items-baseline justify-between gap-4 border-b border-kumo-hairline py-2">
                  <dt className="text-xs text-kumo-subtle">Model</dt>
                  <dd className="m-0 text-right">
                    <Mono tone="strong">AI_MODEL</Mono>
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-4 border-b border-kumo-hairline py-2">
                  <dt className="text-xs text-kumo-subtle">Writes to GitHub</dt>
                  <dd className="m-0 text-right text-xs font-medium text-kumo-strong">No</dd>
                </div>
                <div className="flex items-baseline justify-between gap-4 border-b border-kumo-hairline py-2">
                  <dt className="text-xs text-kumo-subtle">Test data</dt>
                  <dd className="m-0 text-right text-xs font-medium text-kumo-strong">Synthetic</dd>
                </div>
              </dl>
            </Panel>
          </GridItem>
          <GridItem>
            <Panel padded={false} className="h-full">
              <PanelHeader
                title="Execution boundaries"
                description="Every run pins its revision, harness, budgets, capabilities, and policy snapshot."
              />
              <dl className="grid px-4 pb-[18px] pt-2">
                {[
                  ["Container", "Ask per run"],
                  ["Network", "Disabled by default"],
                  ["Dependency install", "Disabled by default"],
                  ["GitHub effects", "Exact and policy checked"],
                ].map(([term, detail]) => (
                  <div
                    key={term}
                    className="flex items-baseline justify-between gap-4 border-b border-kumo-hairline py-2"
                  >
                    <dt className="text-xs text-kumo-subtle">{term}</dt>
                    <dd className="m-0 text-right text-xs font-medium text-kumo-strong">{detail}</dd>
                  </div>
                ))}
              </dl>
            </Panel>
          </GridItem>
        </Grid>

        <Panel padded={false}>
          <PanelHeader
            title="Capabilities"
            description="Availability of the broader repository-maintenance roadmap."
          />
          {Object.keys(state.capabilities ?? {}).length ? (
            <div className="grid">
              {Object.entries(state.capabilities ?? {}).map(([name, status]) => (
                <div
                  key={name}
                  className={
                    "flex min-h-12 items-center justify-between gap-4 " +
                    "border-b border-kumo-hairline px-[18px] py-2 last:border-b-0"
                  }
                >
                  <Mono tone="strong">{sentenceCase(name)}</Mono>
                  <StatusBadge tone={status === "available" ? "success" : "neutral"}>
                    {sentenceCase(status)}
                  </StatusBadge>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              compact
              title="No optional capabilities reported"
              description="Optional workspace and authoring capabilities will appear here when configured."
            />
          )}
        </Panel>
      </div>
    </>
  );
}
