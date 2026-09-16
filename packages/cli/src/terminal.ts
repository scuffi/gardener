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

export const terminal = {
  title: (value: string): string => paint(`${ANSI.bold}${ANSI.green}`, value),
  heading: (value: string): string => paint(`${ANSI.bold}${ANSI.green}`, value),
  strong: (value: string): string => paint(ANSI.bold, value),
  muted: (value: string): string => paint(ANSI.dim, value),
  success: (value: string): string => paint(ANSI.green, value),
  value: (value: string): string => paint(ANSI.cyan, value),
  caution: (value: string): string => paint(ANSI.yellow, value),
  error: (value: string): string => paint(ANSI.red, value),
};
