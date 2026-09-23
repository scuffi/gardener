import { stdout } from "node:process";

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  cyan: "\u001b[36m",
} as const;

export function colorsEnabled(): boolean {
  if (Object.prototype.hasOwnProperty.call(process.env, "NO_COLOR")) return false;
  if (process.env.TERM === "dumb") return false;
  if (process.env.FORCE_COLOR === "0") return false;
  return stdout.isTTY === true || Boolean(process.env.FORCE_COLOR);
}

function paint(code: string, value: string): string {
  return colorsEnabled() ? `${code}${value}${ANSI.reset}` : value;
}

/**
 * Writes an operator warning to stderr. Warnings go to stderr so that piping
 * stdout into a file or a JSON parser never silently discards them, and never
 * corrupts the JSON the command emits on stdout.
 */
export function warn(message: string): void {
  process.stderr.write(`${paint(ANSI.yellow, `warning: ${message}`)}\n`);
}

export const terminal = {
  warn,
  title: (value: string): string => paint(`${ANSI.bold}${ANSI.green}`, value),
  heading: (value: string): string => paint(`${ANSI.bold}${ANSI.green}`, value),
  strong: (value: string): string => paint(ANSI.bold, value),
  muted: (value: string): string => paint(ANSI.dim, value),
  success: (value: string): string => paint(ANSI.green, value),
  value: (value: string): string => paint(ANSI.cyan, value),
  caution: (value: string): string => paint(ANSI.yellow, value),
  error: (value: string): string => paint(ANSI.red, value),
};
