// Typed errors thrown across the templates service split.
//
// Each entry in this file lets a route handler `instanceof`-detect the cause
// and map it to a structured HTTP response without parsing message strings.

/**
 * Thrown by `saveUserWorkflow` when committing a staged import would clobber
 * an already-saved user workflow (slug match). The route handler maps this to
 * HTTP 409 with `existingSlug` + `suggestedSlug` so the UI can offer a one-
 * click "use suggested name" retry instead of forcing a blind overwrite.
 */
export class WorkflowNameCollisionError extends Error {
  readonly existingSlug: string;
  readonly suggestedSlug: string;
  /**
   * Index into `staged.workflows` whose computed slug collided. Optional
   * because direct `saveUserWorkflow` callers don't have a staged row to
   * point at — it's only set by the commit pre-flight, where the UI uses
   * it to target `titleOverrides[index]` on the retry.
   */
  readonly workflowIndex?: number;
  constructor(existingSlug: string, suggestedSlug: string, workflowIndex?: number) {
    super(`A workflow named "${existingSlug}" already exists.`);
    this.name = 'WorkflowNameCollisionError';
    this.existingSlug = existingSlug;
    this.suggestedSlug = suggestedSlug;
    if (workflowIndex !== undefined) this.workflowIndex = workflowIndex;
  }
}
