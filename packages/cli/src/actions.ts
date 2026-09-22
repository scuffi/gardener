export interface ActionsEnrollment {
  repositoryId: string;
  ownerId: string;
  ownerLogin: string;
  repositoryName: string;
  visibility: "public" | "private" | "internal";
  workflowRef: string;
  audience: string;
}

export function actionsEnrollmentSql(input: ActionsEnrollment): string {
  validateNumericId(input.repositoryId, "repository id");
  validateNumericId(input.ownerId, "owner id");
  validateName(input.ownerLogin, "owner login");
  validateName(input.repositoryName, "repository name");
  validateWorkflowRef(input.workflowRef);
  validateAudience(input.audience);
  if (!["public", "private", "internal"].includes(input.visibility)) {
    throw new Error(`Unsupported repository visibility: ${input.visibility}`);
  }
  const values = [
    input.repositoryId,
    input.ownerId,
    input.ownerLogin,
    input.repositoryName,
    input.visibility,
    input.workflowRef,
    input.workflowRef,
    input.audience,
  ].map(sqlString).join(",");
  return `INSERT INTO actions_repository_enrollments (repository_id,owner_id,owner_login,repository_name,visibility,plan_job_workflow_ref,effects_job_workflow_ref,oidc_audience,enabled) VALUES (${values},1) ON CONFLICT(repository_id) DO UPDATE SET owner_id=excluded.owner_id,owner_login=excluded.owner_login,repository_name=excluded.repository_name,visibility=excluded.visibility,plan_job_workflow_ref=excluded.plan_job_workflow_ref,effects_job_workflow_ref=excluded.effects_job_workflow_ref,oidc_audience=excluded.oidc_audience,updated_at=CURRENT_TIMESTAMP;`;
}

function validateNumericId(value: string, label: string): void {
  if (!/^[1-9][0-9]{0,19}$/.test(value)) throw new Error(`Invalid ${label}`);
}

function validateName(value: string, label: string): void {
  if (value.length < 1 || value.length > 100 || /[\u0000-\u001f]/.test(value)) throw new Error(`Invalid ${label}`);
}

function validateWorkflowRef(value: string): void {
  if (value.includes("/../") || value.includes("/./") || value.includes("//") || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/[A-Za-z0-9_.\/-]+\.ya?ml@[0-9a-f]{40}$/.test(value)) {
    throw new Error("Reusable workflow reference must use owner/repository/.github/workflows/file.yml@<full-sha>");
  }
}

function validateAudience(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Actions audience must be an HTTPS origin");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || value !== url.origin) {
    throw new Error("Actions audience must be an HTTPS origin without credentials, path, query, fragment, or trailing slash");
  }
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
