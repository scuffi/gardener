import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { ArrowClockwiseIcon, CpuIcon, DatabaseIcon, GithubLogoIcon, SignOutIcon, StackIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useGardener } from "../app-context";
import { gardenerApi } from "../lib/api";
import { sentenceCase } from "../lib/format";
import { useNotifications } from "../components/notifications";
import { ThemePicker } from "../theme";
import { PageHeader, SectionHeader, StatusBadge, Surface } from "../components/ui";

export function SettingsPage() {
  const { state, health, signOut } = useGardener();
  const { notify } = useNotifications();
  const navigate = useNavigate();
  const testMutation = useMutation({
    mutationFn: gardenerApi.testAi,
    onSuccess: ({ model, usage }) => notify({ tone: "success", title: "Workers AI responded successfully", description: `${model}${typeof usage?.costUsd === "number" ? ` · Test cost $${usage.costUsd.toFixed(6)}` : ""}` }),
    onError: (error: Error) => notify({ tone: "error", title: "Workers AI test failed", description: error.message }),
  });
  if (!state || !health) return null;
  const services = [
    { name: "D1 database", description: "Workflow state and durable audit records", ready: health.database, icon: DatabaseIcon },
    { name: "Cloudflare Queues", description: "Asynchronous run delivery and retries", ready: health.queue, icon: StackIcon },
    { name: "Workers AI", description: "Bounded structured model execution", ready: health.workersAi, icon: CpuIcon },
    { name: "Gardener Connect", description: "GitHub identity, installation access, and writes", ready: health.connectConfigured, icon: GithubLogoIcon },
  ];

  return <>
    <PageHeader title="Settings" description="Inspect provisioned Cloudflare services, execution limits, preview capabilities, and your dashboard session." />
    {!health.ok ? <Banner variant="error" icon={<WarningCircleIcon size={20} weight="fill" />} title="Deployment configuration is incomplete" description="Resolve every unavailable service below before relying on repository automation." /> : null}

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
        <SectionHeader title="Workers AI binding" description="Send synthetic issue data through the configured model and validate the structured response." />
        <dl className="definition-list"><div><dt>Model</dt><dd><code>AI_MODEL</code></dd></div><div><dt>Writes to GitHub</dt><dd>No</dd></div><div><dt>Test data</dt><dd>Synthetic</dd></div></dl>
        <Button variant="secondary" icon={ArrowClockwiseIcon} loading={testMutation.isPending} disabled={!health.workersAi} onClick={() => testMutation.mutate()}>Test Workers AI binding</Button>
      </Surface>
      <Surface>
        <SectionHeader title="Execution limits" description="Hard limits applied to every issue-gardening run." />
        <dl className="definition-list"><div><dt>Model output</dt><dd>800 tokens</dd></div><div><dt>Proposals per run</dt><dd>4 maximum</dd></div><div><dt>Authorization grant</dt><dd>5 minutes</dd></div><div><dt>Comment scope</dt><dd>Bounded</dd></div></dl>
      </Surface>
    </div>

    <Surface padded={false}>
      <SectionHeader title="Capabilities" description="Availability of the broader repository-maintenance roadmap." />
      <div className="capability-list">{Object.entries(state.capabilities).map(([name, status]) => <div key={name}><span>{sentenceCase(name)}</span><StatusBadge tone={status === "available" ? "success" : "neutral"}>{sentenceCase(status)}</StatusBadge></div>)}</div>
    </Surface>

    <Surface className="session-panel">
      <div><h2>Signed in as {state.viewer.login}</h2><p>This temporary Connect-issued session is scoped to this Gardener instance and stored in a secure HttpOnly cookie.</p></div>
      <Button variant="secondary-destructive" icon={SignOutIcon} onClick={() => { signOut(); navigate("/overview", { replace: true }); }}>Sign out</Button>
    </Surface>
  </>;
}
