import { Banner } from "@cloudflare/kumo/components/banner";
import { CpuIcon, DatabaseIcon, GithubLogoIcon, HardDrivesIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useGardener } from "../app-context";
import { sentenceCase } from "../lib/format";
import { ThemePicker } from "../theme";
import { PageHeader, SectionHeader, StatusBadge, Surface } from "../components/ui";

export function SettingsPage() {
  const { state, health } = useGardener();
  if (!state || !health) return null;
  const services = [
    { name: "D1 database", description: "Agents, decisions, runs, effects, and audit records", ready: health.database, icon: DatabaseIcon },
    { name: "Durable orchestration", description: `Run continuation, retries, waits, and cancellation · ${sentenceCase(health.agentRuntime.status)}`, ready: health.agentRuntime.enabled, icon: HardDrivesIcon },
    { name: "Cloudflare AI", description: "Replaceable model harness through the AI binding", ready: health.workersAi, icon: CpuIcon },
    { name: "Gardener Connect", description: "GitHub identity, installation access, and writes", ready: health.connectConfigured, icon: GithubLogoIcon },
  ];

  return <>
    <PageHeader title="Settings" description="Inspect this instance's Cloudflare services, model harness, workspace availability, and runtime limits." />
    {!health.ok ? <Banner variant="error" icon={<WarningCircleIcon size={20} weight="fill" />} title="Agent execution is fail closed" description="Authoring and review are available, but this foundation cannot run Agents or execute effects until the trusted runtime is integrated and staged." /> : null}

    <Surface padded={false}>
      <SectionHeader title="Deployment health" description="Required services for this customer-owned Gardener instance." />
      <div className="health-list">{services.map((service) => <div className="health-row" key={service.name}>
        <span className="health-row__icon"><service.icon size={19} aria-hidden="true" /></span>
        <div><strong>{service.name}</strong><p>{service.description}</p></div>
        <StatusBadge tone={service.ready ? "success" : "error"}>{service.ready ? "Ready" : "Unavailable"}</StatusBadge>
      </div>)}</div>
    </Surface>

    <Surface className="appearance-panel" padded={false}>
      <SectionHeader title="Appearance" description="Choose how this Gardener workspace looks on this device." />
      <ThemePicker />
    </Surface>

    <div className="settings-columns">
      <Surface>
        <SectionHeader title="Cloudflare AI binding" description="Send synthetic data through the configured model without granting tools or repository authority." />
        <dl className="definition-list"><div><dt>Model</dt><dd><code>AI_MODEL</code></dd></div><div><dt>Writes to GitHub</dt><dd>No</dd></div><div><dt>Test data</dt><dd>Synthetic</dd></div></dl>
      </Surface>
      <Surface>
        <SectionHeader title="Execution boundaries" description="Every run pins its revision, harness, budgets, capabilities, and policy snapshot." />
        <dl className="definition-list"><div><dt>Container</dt><dd>Ask per run</dd></div><div><dt>Network</dt><dd>Disabled by default</dd></div><div><dt>Dependency install</dt><dd>Disabled by default</dd></div><div><dt>GitHub effects</dt><dd>Exact and policy checked</dd></div></dl>
      </Surface>
    </div>

    <Surface padded={false}>
      <SectionHeader title="Capabilities" description="Availability of the broader repository-maintenance roadmap." />
      <div className="capability-list">{Object.entries(state.capabilities ?? {}).map(([name, status]) => <div key={name}><span>{sentenceCase(name)}</span><StatusBadge tone={status === "available" ? "success" : "neutral"}>{sentenceCase(status)}</StatusBadge></div>)}</div>
    </Surface>

  </>;
}
