// Shared sanitizer for job/dataset names that become filesystem path
// components (dataset dir, generated config filename, save-folder name).
// Mirrors `routes/ace/training.routes.ts`'s `sanitizeName` — strips
// everything except a safe identifier charset so no traversal or
// absolute-path injection is possible regardless of client input.

export function sanitizeIdentifier(name: string | undefined, fallback = 'untitled'): string {
  const trimmed = (name ?? '').trim();
  const safe = trimmed.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  return safe || fallback;
}
