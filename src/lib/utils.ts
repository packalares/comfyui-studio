import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Format bytes as a human-readable string (e.g. "3.4 GB").
 * Returns "0 B" for 0/undefined/negative inputs.
 */
export function formatBytes(bytes: number | undefined | null): string {
  if (!bytes || bytes <= 0 || !Number.isFinite(bytes)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

/**
 * Format a date (ISO string, Date, or epoch ms) as a short relative time
 * like "just now", "2 min ago", "3 hr ago", "yesterday", or a date string
 * for anything older than a week.
 */
export function formatRelativeTime(input: string | number | Date | undefined | null): string {
  if (!input) return '';
  const date = input instanceof Date ? input : new Date(input);
  const ms = date.getTime();
  if (Number.isNaN(ms)) return '';
  const diffSec = Math.round((Date.now() - ms) / 1000);
  if (diffSec < 5) return 'just now';
  if (diffSec < 60) return `${diffSec} sec ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hr ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay === 1) return 'yesterday';
  if (diffDay < 7) return `${diffDay} days ago`;
  return date.toLocaleDateString();
}
