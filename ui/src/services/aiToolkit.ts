// Typed API client for the Train LoRA page (`pages/TrainLora.tsx` +
// `pages/loraTrain/*`). Same pattern as `services/ace.ts`: route specs are
// defined inline as typed constants, Zod schemas come from the shared
// contract package so request/response shapes stay in lock-step with the
// server.

import { apiCall } from '../api/client.js';
import {
  BaseModelsResponseSchema,
  DatasetListResponseSchema,
  StartTrainingBodySchema,
  StartTrainingResponseSchema,
  JobListQuerySchema,
  JobListResponseSchema,
  JobParamsSchema,
  AiToolkitJobViewSchema,
  CancelJobResponseSchema,
  JobLogsResponseSchema,
} from '@server/contracts/aiToolkit.contract';
import { ApiClientError } from '../api/error.js';

export type AiToolkitArch = 'flux' | 'sdxl' | 'sd35' | 'other';
export type AiToolkitJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type LocalBaseModel = { source: 'local'; id: string; folder: string; sizeBytes: number };
export type HfBaseModelPreset = { source: 'huggingface'; id: string; label: string; arch: AiToolkitArch; note?: string };
export type DatasetSummary = { name: string; imageCount: number; captionedCount: number; updatedAt: number | null };
export type AiToolkitJob = {
  id: string;
  name: string;
  baseModel: string;
  arch: AiToolkitArch | null;
  datasetName: string | null;
  status: AiToolkitJobStatus;
  progress: number;
  step: number;
  totalSteps: number;
  outputFilename: string | null;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  createdAt: number;
  updatedAt: number;
};
export type StartTrainingBody = {
  name: string;
  baseModel: string;
  arch: AiToolkitArch;
  datasetName: string;
  triggerWord?: string;
  steps: number;
  learningRate: number;
  rank: number;
  alpha?: number;
  batchSize: number;
  resolution: number;
  saveEvery: number;
  seed?: number;
  lowVram?: boolean;
};

const baseModelsSpec = {
  method: 'GET',
  path: '/ai-toolkit/base-models',
  response: BaseModelsResponseSchema,
  auth: { required: true, scopes: ['system:read'] },
} as const;

const datasetsSpec = {
  method: 'GET',
  path: '/ai-toolkit/datasets',
  response: DatasetListResponseSchema,
  auth: { required: true, scopes: ['system:read'] },
} as const;

const startJobSpec = {
  method: 'POST',
  path: '/ai-toolkit/jobs',
  body: StartTrainingBodySchema,
  response: StartTrainingResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
} as const;

const listJobsSpec = {
  method: 'GET',
  path: '/ai-toolkit/jobs',
  query: JobListQuerySchema,
  response: JobListResponseSchema,
  auth: { required: true, scopes: ['system:read'] },
} as const;

const getJobSpec = {
  method: 'GET',
  path: '/ai-toolkit/jobs/:id',
  params: JobParamsSchema,
  response: AiToolkitJobViewSchema,
  auth: { required: true, scopes: ['system:read'] },
} as const;

const jobLogsSpec = {
  method: 'GET',
  path: '/ai-toolkit/jobs/:id/logs',
  params: JobParamsSchema,
  response: JobLogsResponseSchema,
  auth: { required: true, scopes: ['system:read'] },
} as const;

const cancelJobSpec = {
  method: 'POST',
  path: '/ai-toolkit/jobs/:id/cancel',
  params: JobParamsSchema,
  response: CancelJobResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
} as const;

export const listBaseModels = (): Promise<{ local: LocalBaseModel[]; presets: HfBaseModelPreset[] }> =>
  apiCall(baseModelsSpec, {});

export const listDatasets = (): Promise<DatasetSummary[]> =>
  apiCall(datasetsSpec, {}).then((r) => r.items);

export const startTrainingJob = (body: StartTrainingBody): Promise<{ jobId: string }> =>
  apiCall(startJobSpec, { body });

export const listTrainingJobs = (limit?: number): Promise<AiToolkitJob[]> =>
  apiCall(listJobsSpec, { query: limit ? { limit } : {} }).then((r) => r.items as AiToolkitJob[]);

export const getTrainingJob = (id: string): Promise<AiToolkitJob> =>
  apiCall(getJobSpec, { params: { id } }) as Promise<AiToolkitJob>;

export const getTrainingJobLogs = (id: string): Promise<string[]> =>
  apiCall(jobLogsSpec, { params: { id } }).then((r) => r.lines);

export const cancelTrainingJob = (id: string): Promise<{ jobId: string; cancelled: boolean }> =>
  apiCall(cancelJobSpec, { params: { id } });

/**
 * Upload dataset files (images + optional matching `.txt` captions) via raw
 * `fetch` + `FormData` — mirrors `services/ace.ts`'s `uploadTrainingAudio`
 * (multipart bodies bypass `apiCall`'s JSON-body path entirely).
 */
export async function uploadDatasetFiles(
  datasetName: string,
  files: File[],
): Promise<{ name: string; uploadedCount: number; imageCount: number; captionedCount: number }> {
  const form = new FormData();
  for (const f of files) form.append('files', f);
  const res = await fetch(`/api/ai-toolkit/datasets/${encodeURIComponent(datasetName)}/upload`, {
    method: 'POST',
    body: form,
  });
  let body: unknown = null;
  try { body = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) {
    const e = body && typeof body === 'object' && 'error' in body
      ? (body as { error: { code?: string; message?: string } }).error
      : null;
    throw new ApiClientError({
      code: (e?.code as never) ?? 'upstream_unavailable',
      status: res.status,
      message: e?.message ?? `Upload failed: ${res.status}`,
    });
  }
  return (body as { data: { name: string; uploadedCount: number; imageCount: number; captionedCount: number } }).data;
}
