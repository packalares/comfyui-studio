// Videoboard typed API client
// All endpoints live under /api/videoboard/*

// ---- Domain types ----

export interface ProjectSettings {
  fixedShotSeconds: number
  styleHint: string
  imageTemplateName: string
  imageWidth?: number
  imageHeight?: number
}

export interface Shot {
  idx: number
  startMs: number
  endMs: number
  lyrics: string
  prompt: string
  seed: number
  imageUrl?: string
  videoUrl?: string
  status: 'pending' | 'queued' | 'generating' | 'ready' | 'error'
  // Director output — present when shots came from OMNI_AUDIO_VideoScenes.
  imagePrompt?: string
  videoPrompt?: string
  keyVisual?: string
  treatmentSnapshot?: string
  chunkIdx?: number
  imageTemplateName?: string
  imagePromptId?: string
}

export interface Project {
  id: string
  name: string
  audioPath?: string
  audioDurationMs?: number
  analysisStatus: 'none' | 'pending' | 'ready' | 'error'
  characterIds: string[]
  shots: Shot[]
  settings: ProjectSettings
  status: 'draft' | 'generating' | 'ready' | 'error'
  createdAt: number
  updatedAt: number
}

// Analysis — produced verbatim by OMNI_AUDIO_Analyze in ComfyUI. Field names
// are snake_case because this shape IS the analyzer JSON; no mapping layer
// between the node and this client. Keep in sync with the server contract at
// server/src/contracts/videoboard.ts.

export interface AudioMeta {
  format: string | null
  size_bytes: number | null
  bitrate_kbps: number | null
  channels: number | null
  sample_rate: number | null
}

export type TempoTag = 'Slow' | 'Mid' | 'Upbeat' | 'Fast'

export interface Analysis {
  identifier: string
  duration: number
  duration_ms: number

  bpm: number
  bpm_min: number | null
  bpm_max: number | null
  tempo_tag: TempoTag | null
  time_signature: string | null

  keyscale: string

  language: string | null
  lang_code: string | null

  audio_meta: AudioMeta

  // Single string from the Transcriber with section labels preserved inline.
  // No per-line timestamps (the model doesn't emit real ones).
  lyrics: string | null

  // flattened captioner output
  genre: string | null
  style: string | null
  short_description: string | null
  full_description: string | null
  mood: string | null
  keywords: string[] | null
  instruments: string[] | null
  vocals: string | null
  era_feel: string | null
  narrative_arc: string | null
  subject: string | null
  color_palette: string[] | null
  setting_hint: string | null

  caption_raw: string | null
}

export interface Character {
  id: string
  name: string
  kind: 'pulid' | 'lora'
  baseModel: 'flux2-klein' | 'flux1-dev' | 'sdxl'
  refPhotoUrls: string[]
  pulidEmbedPath?: string
  loraPath?: string
  createdAt: number
}

export type JobKind = 'analyze' | 'storyboard' | 'image' | 'video' | 'render' | 'train-lora'

export interface JobRecord {
  id: string
  projectId: string
  shotIdx?: number
  kind: JobKind
  status: 'queued' | 'running' | 'done' | 'error'
  progress: number
  message?: string
  outputUrl?: string
  createdAt: number
  updatedAt: number
}

// ---- Helpers ----

const BASE = '/api/videoboard'

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init)
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`Videoboard API ${res.status}: ${text}`)
  }
  return res.json() as Promise<T>
}

// ---- Projects ----

export function listProjects(): Promise<Project[]> {
  return req('/projects')
}

export function createProject(name: string): Promise<Project> {
  return req('/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
}

export function getProject(id: string): Promise<Project> {
  return req(`/projects/${id}`)
}

export function updateProject(id: string, partial: Partial<Project>): Promise<Project> {
  return req(`/projects/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(partial),
  })
}

export function deleteProject(id: string): Promise<{ ok: boolean }> {
  return req(`/projects/${id}`, { method: 'DELETE' })
}

export function updateProjectSettings(
  id: string,
  settings: Partial<ProjectSettings>,
  currentSettings: ProjectSettings,
): Promise<Project> {
  return req(`/projects/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings: { ...currentSettings, ...settings } }),
  })
}

export function uploadAudio(id: string, file: File): Promise<{ audioPath: string }> {
  const fd = new FormData()
  fd.append('audio', file)
  return req(`/projects/${id}/audio`, { method: 'POST', body: fd })
}

export function deleteAudio(projectId: string): Promise<Project> {
  return req(`/projects/${projectId}/audio`, { method: 'DELETE' })
}

export function analyzeProject(id: string): Promise<{ jobId: string }> {
  return req(`/projects/${id}/analyze`, { method: 'POST' })
}

export function getAnalysis(id: string): Promise<Analysis | null> {
  return req(`/projects/${id}/analysis`)
}

export function generateStoryboard(id: string): Promise<{ jobId: string }> {
  return req(`/projects/${id}/storyboard/generate`, { method: 'POST' })
}

export function updateShot(
  id: string,
  idx: number,
  partial: Partial<Shot>,
): Promise<Shot> {
  return req(`/projects/${id}/shots/${idx}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(partial),
  })
}

export function generateShotImage(
  id: string,
  idx: number,
  opts: { templateName?: string } = {},
): Promise<{ jobId: string }> {
  const body = opts.templateName ? { templateName: opts.templateName } : {}
  return req(`/projects/${id}/shots/${idx}/image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function generateAllShotImages(
  id: string,
  opts: { templateName?: string } = {},
): Promise<{ queued: number[]; skipped: number; message?: string }> {
  const body = opts.templateName ? { templateName: opts.templateName } : {}
  return req(`/projects/${id}/shots/images/generate-all`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function animateShot(id: string, idx: number): Promise<{ jobId: string }> {
  return req(`/projects/${id}/shots/${idx}/animate`, { method: 'POST' })
}

export function generateAllShotVideos(
  id: string,
  opts: { templateName?: string } = {},
): Promise<{ queued: number[]; skipped: number; message?: string }> {
  const body = opts.templateName ? { templateName: opts.templateName } : {}
  return req(`/projects/${id}/shots/videos/generate-all`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// Chain-mode i2v: shots run serially, each one's saved latent feeds the next.
// Slower than FLF2V but produces smoother motion continuity. Shot 0 needs a
// seed image — caller passes `startingImageUrl` (typically shot[0].imageUrl).
export function generateChainVideos(
  id: string,
  opts: {
    startIdx?: number
    stopIdx?: number
    startingImageUrl?: string
    templateName?: string
  } = {},
): Promise<{ jobId: string; startIdx: number; stopIdx: number; shotCount: number }> {
  return req(`/projects/${id}/shots/chain/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  })
}

export function renderProject(id: string): Promise<{ jobId: string }> {
  return req(`/projects/${id}/render`, { method: 'POST' })
}

// ---- Characters ----

export function listCharacters(): Promise<Character[]> {
  return req('/characters')
}

export interface CreateCharacterPayload {
  name: string
  kind: Character['kind']
  baseModel: Character['baseModel']
  refPhotos: File[]
}

export function createCharacter(payload: CreateCharacterPayload): Promise<Character> {
  const fd = new FormData()
  fd.append('name', payload.name)
  fd.append('kind', payload.kind)
  fd.append('baseModel', payload.baseModel)
  for (const f of payload.refPhotos) {
    fd.append('refPhotos', f)
  }
  return req('/characters', { method: 'POST', body: fd })
}

export function getCharacter(id: string): Promise<Character> {
  return req(`/characters/${id}`)
}

export function deleteCharacter(id: string): Promise<{ ok: boolean }> {
  return req(`/characters/${id}`, { method: 'DELETE' })
}

export function trainLoRA(id: string): Promise<{ jobId: string }> {
  return req(`/characters/${id}/train-lora`, { method: 'POST' })
}
