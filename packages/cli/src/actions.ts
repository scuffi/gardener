import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { runCommand } from "./commands.js";

export interface ActionsEnrollment {
  repositoryId: string;
  ownerId: string;
  ownerLogin: string;
  repositoryName: string;
  visibility: "public" | "private" | "internal";
  workflowRef: string;
  audience: string;
}

export function renderActionsCaller(input: { workflowRef: string; audience: string; taskBundleHash: string }): string {
  validateWorkflowRef(input.workflowRef);
  validateAudience(input.audience);
  validateSha256(input.taskBundleHash, "task bundle hash");
  return `name: Gardener triage

on:
  issues:
    types: [opened]

permissions: {}

jobs:
  gardener:
    if: \${{ contains(github.event.issue.labels.*.name, 'gardener-test') }}
    permissions:
      contents: read
      issues: write
      id-token: write
    uses: ${input.workflowRef}
    with:
      runtime-url: ${input.audience}
      task-bundle-hash: ${input.taskBundleHash}
`;
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

export async function writeActionsCaller(options: {
  workflowRef: string;
  audience: string;
  taskBundleHash: string;
  output: string;
}): Promise<string> {
  const output = resolve(options.output);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, renderActionsCaller(options), { encoding: "utf8", mode: 0o644 });
  return output;
}

export async function disableActionsRepository(options: {
  repositoryRoot: string;
  repository: string;
  config: string;
  databaseBinding?: string;
}): Promise<{ repositoryId: string; disabled: true }> {
  validateRepositorySlug(options.repository);
  const result = runCommand("gh", ["api", `repos/${options.repository}`, "--jq", ".id|tostring"], {
    cwd: options.repositoryRoot,
    quiet: true,
  });
  const repositoryId = result.stdout.trim();
  validateNumericId(repositoryId, "repository id");
  runCommand("pnpm", [
    "exec", "wrangler", "d1", "execute", options.databaseBinding ?? "DB",
    "--remote", "--config", options.config,
    "--command", `UPDATE actions_repository_enrollments SET enabled=0,updated_at=CURRENT_TIMESTAMP WHERE repository_id=${sqlString(repositoryId)};`,
  ], { cwd: options.repositoryRoot });
  return { repositoryId, disabled: true };
}

export async function enrollActionsRepository(options: {
  repositoryRoot: string;
  repository: string;
  workflowRef: string;
  audience: string;
  config: string;
  databaseBinding?: string;
}): Promise<ActionsEnrollment> {
  validateRepositorySlug(options.repository);
  const result = runCommand("gh", [
    "api",
    `repos/${options.repository}`,
    "--jq",
    "{repositoryId:(.id|tostring),ownerId:(.owner.id|tostring),ownerLogin:.owner.login,repositoryName:.name,visibility:.visibility}",
  ], { cwd: options.repositoryRoot, quiet: true });
  const metadata = JSON.parse(result.stdout) as Omit<ActionsEnrollment, "workflowRef" | "audience">;
  const enrollment: ActionsEnrollment = {
    ...metadata,
    workflowRef: options.workflowRef,
    audience: options.audience,
  };
  const sql = actionsEnrollmentSql(enrollment);
  runCommand("pnpm", [
    "exec", "wrangler", "d1", "execute", options.databaseBinding ?? "DB",
    "--remote", "--config", options.config, "--command", sql,
  ], { cwd: options.repositoryRoot });
  return enrollment;
}

function validateRepositorySlug(value: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("--repository must be an owner/name GitHub repository");
  }
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

function validateSha256(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`Invalid ${label}`);
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
