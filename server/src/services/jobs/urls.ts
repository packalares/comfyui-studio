// Single source of truth for job endpoint URL patterns.
// Import this in routes and contracts — never hardcode the paths elsewhere.

export const JOB_STATUS_PATH = '/api/jobs';

export function buildJobUrls(promptId: string): { statusUrl: string; streamUrl: string } {
  return {
    statusUrl: `${JOB_STATUS_PATH}/${encodeURIComponent(promptId)}`,
    streamUrl: `${JOB_STATUS_PATH}/${encodeURIComponent(promptId)}/events`,
  };
}
