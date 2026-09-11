import type { Flag, RunUsage } from "./types";

export function isEnabled(value: Flag): boolean {
  return value === true || value === 1;
}

export function formatDate(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(`${value}Z`.replace("ZZ", "Z"));
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function formatRelativeTime(value?: string | null): string {
  if (!value) return "Never";
  const date = new Date(`${value}Z`.replace("ZZ", "Z"));
  const delta = date.getTime() - Date.now();
  if (Number.isNaN(delta)) return "Unknown";
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const ranges: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 31_536_000_000], ["month", 2_592_000_000], ["day", 86_400_000],
    ["hour", 3_600_000], ["minute", 60_000], ["second", 1_000],
  ];
  for (const [unit, milliseconds] of ranges) {
    if (Math.abs(delta) >= milliseconds || unit === "second") {
      return formatter.format(Math.round(delta / milliseconds), unit);
    }
  }
  return "Just now";
}

export function parseUsage(raw?: string | RunUsage | null): RunUsage | null {
  if (!raw) return null;
  if (typeof raw !== "string") return raw;
  try { return JSON.parse(raw) as RunUsage; } catch { return null; }
}

export function tokenCount(usage: RunUsage | null): number {
  return (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
}

export function formatCost(value?: number): string {
  if (typeof value !== "number") return "—";
  return value < 0.01 ? `$${value.toFixed(6)}` : `$${value.toFixed(2)}`;
}

export function sentenceCase(value: string): string {
  const normalized = value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[._-]+/g, " ").toLowerCase();
  return normalized ? normalized[0]!.toUpperCase() + normalized.slice(1) : "";
}

export function formatTrigger(value: string): string {
  return sentenceCase(value).replace(/^Github\b/, "GitHub");
}

export function parseOperation(raw: string): Record<string, unknown> {
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return { value: raw }; }
}
