const parseTimestamp = (value?: string | null): number | null => {
  if (!value) return null;
  const parsed = new Date(`${value}Z`.replace("ZZ", "Z")).getTime();
  return Number.isNaN(parsed) ? null : parsed;
};

export function formatDuration(startedAt?: string | null, completedAt?: string | null): string {
  const start = parseTimestamp(startedAt);
  if (start === null) return "—";
  const end = parseTimestamp(completedAt) ?? Date.now();
  const seconds = Math.max(0, Math.floor((end - start) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
