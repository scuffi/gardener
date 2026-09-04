export const SYSTEM_PROMPT_TEMPLATE_VERSION = 1 as const;
export const SYSTEM_PROMPT_TEMPLATE_MAX_REFERENCES = 32;

export const systemPromptVariables = [
  { id: "repository.id", label: "Repository ID", description: "Immutable GitHub repository ID.", example: "1318443351" },
  { id: "repository.full_name", label: "Repository", description: "Repository owner and name.", example: "cloudflare/workers-sdk" },
  { id: "event.action", label: "Event action", description: "Normalized event action that started the run.", example: "reopened" },
  { id: "resource.type", label: "Resource type", description: "Normalized repository resource type.", example: "issue" },
  { id: "resource.id", label: "Resource ID", description: "Provider ID for the issue or pull request.", example: "I_kwDOExample" },
  { id: "resource.number", label: "Resource number", description: "Issue or pull-request number.", example: "42" },
] as const;

export type SystemPromptVariableId = (typeof systemPromptVariables)[number]["id"];
export interface SystemPromptTemplateIssue {
  code: "unknown_variable" | "malformed_placeholder" | "too_many_references";
  variable?: string;
  message: string;
}

const variableIds = new Set<string>(systemPromptVariables.map((variable) => variable.id));
const placeholderPattern = /{{\s*([^{}]*?)\s*}}/g;

export function systemPromptTemplateReferences(template: string): string[] {
  return [...template.matchAll(placeholderPattern)].map((match) => match[1]!.trim());
}

export function validateSystemPromptTemplate(template: string): SystemPromptTemplateIssue[] {
  const references = systemPromptTemplateReferences(template);
  const issues: SystemPromptTemplateIssue[] = [];
  const remainder = template.replace(placeholderPattern, "");
  if (remainder.includes("{{") || remainder.includes("}}")) {
    issues.push({ code: "malformed_placeholder", message: "Prompt placeholders must use the form {{resource.id}}" });
  }
  if (references.length > SYSTEM_PROMPT_TEMPLATE_MAX_REFERENCES) {
    issues.push({ code: "too_many_references", message: `Prompt instructions may contain at most ${SYSTEM_PROMPT_TEMPLATE_MAX_REFERENCES} variable references` });
  }
  for (const reference of [...new Set(references)]) {
    if (!variableIds.has(reference)) {
      issues.push({ code: "unknown_variable", variable: reference, message: `Unknown prompt variable: ${reference || "empty placeholder"}` });
    }
  }
  return issues;
}
