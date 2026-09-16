import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SETUP_STEPS = [
  "new",
  "resources-provisioning",
  "resources-provisioned",
  "gateway-shell-deployed",
  "gardener-deployed",
  "gateway-linked",
  "manifest-created",
  "secrets-uploaded",
  "complete",
  "destroyed",
] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

export interface SetupCheckpoint {
  version: 2;
  workspace: string;
  step: SetupStep;
  owner: { id: string; login: string };
  purpose?: "workspace" | "qualification";
  githubAppOwner?:
    | { kind: "personal"; login: string }
    | { kind: "organization"; login: string };
  cloudflareAccountId?: string;
  gardenerDatabaseId?: string;
  gatewayDatabaseId?: string;
  gatewayOrigin?: string;
  gardenerOrigin?: string;
  githubAppSlug?: string;
  updatedAt: string;
}

export interface ManifestCredentials {
  id: number;
  slug: string;
  pem: string;
  webhook_secret: string;
  client_id: string;
  client_secret: string;
  owner: { login: string; type: "User" | "Organization" };
}

export function workspaceDirectory(workspace: string): string {
  const root = process.env.GARDENER_CONFIG_HOME
    ?? join(homedir(), ".config", "gardener");
  return join(root, workspace);
}

export function statePaths(workspace: string) {
  const directory = workspaceDirectory(workspace);
  return {
    directory,
    checkpoint: join(directory, "setup.json"),
    recovery: join(directory, "setup-recovery.json"),
    operatorToken: join(directory, "gateway-operator-token"),
    reports: join(directory, "reports"),
    teardown: join(directory, "teardown.json"),
  };
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

export async function readCheckpoint(path: string): Promise<SetupCheckpoint | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as SetupCheckpoint;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await ensurePrivateDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export async function writePrivateText(path: string, value: string): Promise<void> {
  await ensurePrivateDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, value, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export function atOrAfter(current: SetupStep, target: SetupStep): boolean {
  return SETUP_STEPS.indexOf(current) >= SETUP_STEPS.indexOf(target);
}
