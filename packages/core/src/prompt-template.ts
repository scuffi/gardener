import {
  SYSTEM_PROMPT_TEMPLATE_VERSION,
  validateSystemPromptTemplate,
  type NormalizedIssueEvent,
  type SystemPromptVariableId,
} from "@gardener/contracts";

export { SYSTEM_PROMPT_TEMPLATE_VERSION };

function issuePromptContext(event: NormalizedIssueEvent): Record<SystemPromptVariableId, string> {
  return {
    "repository.id": event.repository.id,
    "repository.full_name": `${event.repository.owner}/${event.repository.name}`,
    "event.action": event.action,
    "resource.type": "issue",
    "resource.id": event.issue.id,
    "resource.number": String(event.issue.number),
  };
}

/** Render only Connect-attested scalar metadata into system instructions. Resource content stays in the user message. */
export function renderSystemPromptTemplate(template: string, event: NormalizedIssueEvent): string {
  const issues = validateSystemPromptTemplate(template);
  if (issues.length) throw new Error(`Invalid system prompt template: ${issues.map((issue) => issue.message).join("; ")}`);
  const context = issuePromptContext(event);
  return template.replace(/{{\s*([^{}]*?)\s*}}/g, (_match, variable: string) => context[variable.trim() as SystemPromptVariableId]);
}
