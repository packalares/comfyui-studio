// Videoboard typed API client — thin wrappers over `apiCall`.
// Route specs are defined inline as typed constants (not imported from server
// route files, which bundle server-only deps). Types come from the shared contract.

import { z } from 'zod';
import { apiCall } from './client.js';
import {
  ProjectSchema,
  AnalysisSchema,
  CharacterSchema,
  JobRecordSchema,
  JobStartedSchema,
  OkSchema,
  GenerateAllResponseSchema,
  ChainStartedSchema,
  CreateProjectBodySchema,
  UpdateProjectBodySchema,
  UpdateShotBodySchema,
  GenerateImageBodySchema,
  GenerateAllImagesBodySchema,
  AnimateShotBodySchema,
  GenerateAllVideosBodySchema,
  GenerateChainBodySchema,
  GenerateStoryboardBodySchema,
} from '@server/contracts/videoboard';

export type {
  Project,
  ProjectSettings,
  Shot,
  Analysis,
  AudioMeta,
  TempoTag,
  Character,
  JobKind,
  JobRecord,
} from '@server/contracts/videoboard';

import type { Project, ProjectSettings, Shot, Character, JobRecord, Analysis } from '@server/contracts/videoboard';

// ---- Param schemas -----------------------------------------------------------

const IdP = z.object({ id: z.string() });
const IdxP = z.object({ id: z.string(), idx: z.coerce.number().int().nonnegative() });

// ---- Projects ----------------------------------------------------------------

const listProjectsSpec = { method: 'GET', path: '/videoboard/projects', response: z.array(ProjectSchema), auth: { required: true, scopes: ['videoboard:read'] } } as const;
const createProjectSpec = { method: 'POST', path: '/videoboard/projects', body: CreateProjectBodySchema, response: ProjectSchema, auth: { required: true, scopes: ['videoboard:write'] } } as const;
const getProjectSpec = { method: 'GET', path: '/videoboard/projects/:id', params: IdP, response: ProjectSchema, auth: { required: true, scopes: ['videoboard:read'] } } as const;
const updateProjectSpec = { method: 'PUT', path: '/videoboard/projects/:id', params: IdP, body: UpdateProjectBodySchema, response: ProjectSchema, auth: { required: true, scopes: ['videoboard:write'] } } as const;
const deleteProjectSpec = { method: 'DELETE', path: '/videoboard/projects/:id', params: IdP, response: OkSchema, auth: { required: true, scopes: ['videoboard:write'] } } as const;
const getAnalysisSpec = { method: 'GET', path: '/videoboard/projects/:id/analysis', params: IdP, response: AnalysisSchema.nullable(), auth: { required: true, scopes: ['videoboard:read'] } } as const;
const analyzeSpec = { method: 'POST', path: '/videoboard/projects/:id/analyze', params: IdP, response: JobStartedSchema, auth: { required: true, scopes: ['videoboard:render'] } } as const;
const generateStoryboardSpec = { method: 'POST', path: '/videoboard/projects/:id/storyboard/generate', params: IdP, body: GenerateStoryboardBodySchema, response: JobStartedSchema, auth: { required: true, scopes: ['videoboard:render'] } } as const;

const updateShotSpec = { method: 'PUT', path: '/videoboard/projects/:id/shots/:idx', params: IdxP, body: UpdateShotBodySchema, response: z.any(), auth: { required: true, scopes: ['videoboard:write'] } } as const;
const generateShotImageSpec = { method: 'POST', path: '/videoboard/projects/:id/shots/:idx/image', params: IdxP, body: GenerateImageBodySchema, response: JobStartedSchema, auth: { required: true, scopes: ['videoboard:render'] } } as const;
const generateAllImagesSpec = { method: 'POST', path: '/videoboard/projects/:id/shots/images/generate-all', params: IdP, body: GenerateAllImagesBodySchema, response: GenerateAllResponseSchema, auth: { required: true, scopes: ['videoboard:render'] } } as const;
const animateShotSpec = { method: 'POST', path: '/videoboard/projects/:id/shots/:idx/animate', params: IdxP, body: AnimateShotBodySchema, response: JobStartedSchema, auth: { required: true, scopes: ['videoboard:render'] } } as const;
const generateAllVideosSpec = { method: 'POST', path: '/videoboard/projects/:id/shots/videos/generate-all', params: IdP, body: GenerateAllVideosBodySchema, response: GenerateAllResponseSchema, auth: { required: true, scopes: ['videoboard:render'] } } as const;
const generateChainSpec = { method: 'POST', path: '/videoboard/projects/:id/shots/chain/generate', params: IdP, body: GenerateChainBodySchema, response: ChainStartedSchema, auth: { required: true, scopes: ['videoboard:render'] } } as const;

const renderProjectSpec = { method: 'POST', path: '/videoboard/projects/:id/render', params: IdP, response: JobStartedSchema, auth: { required: true, scopes: ['videoboard:render'] } } as const;
const getJobSpec = { method: 'GET', path: '/videoboard/jobs/:id', params: IdP, response: JobRecordSchema, auth: { required: true, scopes: ['videoboard:read'] } } as const;

const listCharactersSpec = { method: 'GET', path: '/videoboard/characters', response: z.array(CharacterSchema), auth: { required: true, scopes: ['videoboard:read'] } } as const;
const getCharacterSpec = { method: 'GET', path: '/videoboard/characters/:id', params: IdP, response: CharacterSchema, auth: { required: true, scopes: ['videoboard:read'] } } as const;
const deleteCharacterSpec = { method: 'DELETE', path: '/videoboard/characters/:id', params: IdP, response: OkSchema, auth: { required: true, scopes: ['videoboard:write'] } } as const;
const trainLoraSpec = { method: 'POST', path: '/videoboard/characters/:id/train-lora', params: IdP, response: JobStartedSchema, auth: { required: true, scopes: ['videoboard:render'] } } as const;

// ---- API call wrappers -------------------------------------------------------

export const listProjects = (): Promise<Project[]> => apiCall(listProjectsSpec, {});
export const createProject = (name: string): Promise<Project> => apiCall(createProjectSpec, { body: { name } });
export const getProject = (id: string): Promise<Project> => apiCall(getProjectSpec, { params: { id } });
export const updateProject = (id: string, partial: Partial<Project>): Promise<Project> => apiCall(updateProjectSpec, { params: { id }, body: partial });
export const deleteProject = (id: string): Promise<{ ok: true }> => apiCall(deleteProjectSpec, { params: { id } });
export const updateProjectSettings = (
  id: string,
  settings: Partial<ProjectSettings>,
  currentSettings: ProjectSettings,
): Promise<Project> => apiCall(updateProjectSpec, { params: { id }, body: { settings: { ...currentSettings, ...settings } } });

// Audio (multipart — raw fetch; envelope unwrapped manually)
export function uploadAudio(id: string, file: File): Promise<{ audioPath: string }> {
  const fd = new FormData();
  fd.append('audio', file);
  return fetch(`/api/videoboard/projects/${id}/audio`, { method: 'POST', body: fd })
    .then(async (res) => {
      const body = await res.json() as { data?: { audioPath: string }; audioPath?: string };
      if (!res.ok) throw new Error(`Audio upload ${res.status}`);
      return (body.data ?? body) as { audioPath: string };
    });
}

export function deleteAudio(projectId: string): Promise<Project> {
  return fetch(`/api/videoboard/projects/${projectId}/audio`, { method: 'DELETE' })
    .then(async (res) => {
      const body = await res.json() as { data?: Project } | Project;
      if (!res.ok) throw new Error(`Delete audio ${res.status}`);
      return ('data' in body && body.data ? body.data : body) as Project;
    });
}

export const analyzeProject = (id: string): Promise<{ jobId: string }> => apiCall(analyzeSpec, { params: { id } });
export const getAnalysis = (id: string): Promise<Analysis | null> => apiCall(getAnalysisSpec, { params: { id } });
export const generateStoryboard = (id: string): Promise<{ jobId: string }> => apiCall(generateStoryboardSpec, { params: { id }, body: {} });

export const updateShot = (id: string, idx: number, partial: Partial<Shot>): Promise<Shot> =>
  apiCall(updateShotSpec, { params: { id, idx }, body: partial }) as Promise<Shot>;
export const generateShotImage = (id: string, idx: number, opts: { templateName?: string } = {}): Promise<{ jobId: string }> =>
  apiCall(generateShotImageSpec, { params: { id, idx }, body: { templateName: opts.templateName } });
export const generateAllShotImages = (id: string, opts: { templateName?: string } = {}): Promise<{ queued: number[]; skipped: number; message?: string }> =>
  apiCall(generateAllImagesSpec, { params: { id }, body: { templateName: opts.templateName } });
export const animateShot = (id: string, idx: number, opts: { templateName?: string } = {}): Promise<{ jobId: string }> =>
  apiCall(animateShotSpec, { params: { id, idx }, body: { templateName: opts.templateName } });
export const generateAllShotVideos = (id: string, opts: { templateName?: string } = {}): Promise<{ queued: number[]; skipped: number; message?: string }> =>
  apiCall(generateAllVideosSpec, { params: { id }, body: { templateName: opts.templateName } });
export const generateChainVideos = (
  id: string,
  opts: { startIdx?: number; stopIdx?: number; startingImageUrl?: string; templateName?: string } = {},
): Promise<{ jobId: string; startIdx: number; stopIdx: number; shotCount: number }> =>
  apiCall(generateChainSpec, { params: { id }, body: opts });

export const renderProject = (id: string): Promise<{ jobId: string }> => apiCall(renderProjectSpec, { params: { id } });
export const getJob = (id: string): Promise<JobRecord> => apiCall(getJobSpec, { params: { id } });

export const listCharacters = (): Promise<Character[]> => apiCall(listCharactersSpec, {});
export const getCharacter = (id: string): Promise<Character> => apiCall(getCharacterSpec, { params: { id } });
export const deleteCharacter = (id: string): Promise<{ ok: true }> => apiCall(deleteCharacterSpec, { params: { id } });
export const trainLoRA = (id: string): Promise<{ jobId: string }> => apiCall(trainLoraSpec, { params: { id } });

export interface CreateCharacterPayload {
  name: string;
  kind: Character['kind'];
  baseModel: Character['baseModel'];
  refPhotos: File[];
}

export function createCharacter(payload: CreateCharacterPayload): Promise<Character> {
  const fd = new FormData();
  fd.append('name', payload.name);
  fd.append('kind', payload.kind);
  fd.append('baseModel', payload.baseModel);
  for (const f of payload.refPhotos) fd.append('photos', f);
  return fetch('/api/videoboard/characters', { method: 'POST', body: fd })
    .then(async (res) => {
      const body = await res.json() as { data?: Character } | Character;
      if (!res.ok) throw new Error(`Create character ${res.status}`);
      return ('data' in body && body.data ? body.data : body) as Character;
    });
}
