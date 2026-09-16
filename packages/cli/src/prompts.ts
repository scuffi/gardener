import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

export async function prompt(question: string): Promise<string> {
  const readline = createInterface({ input: stdin, output: stdout });
  try { return (await readline.question(question)).trim(); }
  finally { readline.close(); }
}

export async function confirmExact(question: string, expected: string): Promise<void> {
  const answer = await prompt(`${question}\nType ${expected} to continue: `);
  if (answer !== expected) throw new Error("Confirmation did not match; no further changes were made");
}

export async function resolveGitHubOwner(login: string): Promise<{ id: string; login: string }> {
  const normalized = login.trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(normalized)) {
    throw new Error("Invalid GitHub login");
  }
  const response = await fetch(`https://api.github.com/users/${encodeURIComponent(normalized)}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "gardener-cli" },
  });
  if (response.status === 404) throw new Error(`GitHub user @${normalized} was not found`);
  if (!response.ok) throw new Error(`GitHub user lookup failed (${response.status})`);
  const body = await response.json() as { id?: number; login?: string; type?: string };
  if (!Number.isSafeInteger(body.id) || typeof body.login !== "string" || body.type !== "User") {
    throw new Error("GitHub user lookup returned an invalid human identity");
  }
  return { id: String(body.id), login: body.login };
}
