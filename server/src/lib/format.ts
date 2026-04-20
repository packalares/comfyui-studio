// Pretty-print a byte count using binary units. Canonical definition — all
// services must import from here.

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

export function formatBytes(bytes: number, precision?: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const i = Math.min(UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const digits = precision ?? (i === 0 ? 0 : 2);
  return `${(bytes / Math.pow(1024, i)).toFixed(digits)} ${UNITS[i]}`;
}
