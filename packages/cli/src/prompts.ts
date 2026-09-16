import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { terminal } from "./terminal.js";

export async function prompt(question: string): Promise<string> {
  const readline = createInterface({ input: stdin, output: stdout });
  try { return (await readline.question(question)).trim(); }
  finally { readline.close(); }
}

export async function confirm(question: string, defaultValue: boolean): Promise<boolean> {
  const suffix = defaultValue ? "[Y/n]" : "[y/N]";
  while (true) {
    const answer = (await prompt(`${question} ${terminal.value(suffix)} `)).toLowerCase();
    if (!answer) return defaultValue;
    if (answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
    console.log(terminal.caution("Please answer yes or no."));
  }
}

export async function select(
  question: string,
  options: Array<{ label: string; description: string }>,
  defaultIndex = 0,
): Promise<number> {
  console.log(question);
  options.forEach((option, index) => {
    console.log(`  ${terminal.value(`${index + 1})`)} ${terminal.strong(option.label)}`);
    console.log(`     ${terminal.muted(option.description)}`);
  });
  while (true) {
    const answer = await prompt(`Choice ${terminal.value(`[${defaultIndex + 1}]`)}: `);
    if (!answer) return defaultIndex;
    const selected = Number(answer) - 1;
    if (Number.isInteger(selected) && selected >= 0 && selected < options.length) return selected;
    console.log(terminal.caution(`Please enter a number from 1 to ${options.length}.`));
  }
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
