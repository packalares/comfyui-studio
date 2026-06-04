import { useCallback, useEffect, useRef, useState, Suspense, lazy } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, Film, LayoutGrid, Loader2, Music, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '../components/ui/button'
import { Spinner } from '../components/ui/spinner'
import {
  getProject,
  getAnalysis,
  analyzeProject,
  uploadAudio,
  deleteAudio,
  updateProject,
  updateShot,
  generateShotImage,
  generateAllShotImages,
  animateShot,
  generateAllShotVideos,
  generateChainVideos,
  type Project,
  type Shot,
  type Analysis,
} from '../api/videoboard'
import { useVideoboardEvents } from '../services/videoboardEvents'

const AudioPanel = lazy(() =>
  import('../components/videoboard/AudioPanel').then((m) => ({ default: m.AudioPanel })),
)
const AnalyzeView = lazy(() =>
  import('../components/videoboard/AnalyzeView').then((m) => ({ default: m.AnalyzeView })),
)
const StoryboardGrid = lazy(() =>
  import('../components/videoboard/StoryboardGrid').then((m) => ({ default: m.StoryboardGrid })),
)
const ShotDetailModal = lazy(() =>
  import('../components/videoboard/ShotDetailModal').then((m) => ({ default: m.ShotDetailModal })),
)
const ConfirmDialog = lazy(() =>
  import('../components/modals/ConfirmDialog').then((m) => ({ default: m.default })),
)

function PanelFallback() {
  return (
    <div className="flex items-center justify-center p-6 text-muted-foreground">
      <Spinner size="sm" />
    </div>
  )
}

export default function VideoboardProject() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [project, setProject] = useState<Project | null>(null)
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [loading, setLoading] = useState(true)
  // `analyzing` is OPTIMISTIC (clicked Analyze but server hasn't broadcast yet).
  // Render code below ORs it with `project?.analysisStatus === 'pending'` so
  // that a fresh page-load with a still-running server-side analyze shows the
  // spinner without needing the WS to fire again.
  const [analyzing, setAnalyzing] = useState(false)
  // Track the shot being edited by idx (not by frozen object reference) so the
  // modal stays in sync with WS-driven updates on the same shot — otherwise
  // status/imageUrl changes from `videoboard:shot:updated` never reach the
  // modal because it was holding a snapshot taken at click time.
  const [editShotIdx, setEditShotIdx] = useState<number | null>(null)
  const [activeTab, setActiveTab] = useState<'analyze' | 'storyboard' | 'result'>('analyze')
  // Incremented whenever audio is replaced so the <audio> element re-fetches
  // even though the URL path stays the same.
  const [audioVersion, setAudioVersion] = useState(0)

  // Derived: combine optimistic local state with persisted server status so
  // a hard refresh while analyze is mid-flight still shows the spinner.
  const isAnalyzing = analyzing || project?.analysisStatus === 'pending'

  // Hidden file input for "Replace audio" action
  const replaceInputRef = useRef<HTMLInputElement>(null)

  const loadProject = useCallback(async () => {
    if (!id) return
    try {
      const p = await getProject(id)
      setProject(p)
      if (p.analysisStatus === 'ready') {
        const a = await getAnalysis(id)
        if (a) setAnalysis(a)
      }
    } catch (err) {
      toast.error('Failed to load project', {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { void loadProject() }, [loadProject])

  // WS subscriptions for this project
  useVideoboardEvents(id ?? '', {
    onAnalysisUpdated: (a) => {
      setAnalysis(a)
      setAnalyzing(false)
      setProject((prev) => prev ? { ...prev, analysisStatus: 'ready' } : prev)
    },
    onProjectUpdated: (p) => {
      setProject(p)
      // If the server cleared audio (Remove / Replace mid-analyze), drop our
      // local analysis state so the UI doesn't show stale lyrics/sections
      // until a new analyze fires.
      if (!p.audioPath || p.analysisStatus === 'none') {
        setAnalysis(null)
        setAnalyzing(false)
      }
    },
    onJob: (job) => {
      if (job.kind === 'analyze') {
        if (job.status === 'running' || job.status === 'queued') {
          setAnalyzing(true)
        } else if (job.status === 'done') {
          setAnalyzing(false)
        } else if (job.status === 'error') {
          setAnalyzing(false)
          toast.error('Analysis failed', { description: job.message })
        }
      } else if (job.kind === 'image' && job.status === 'error') {
        // Toast the user when the backend gives up on a shot's image gen so
        // they don't have to dig into the modal to see the failure.
        toast.error(`Shot ${(job.shotIdx ?? 0) + 1} image failed`, {
          description: job.message,
        })
      }
    },
    onShotUpdated: (shot) => {
      // Without this handler, `videoboard:shot:updated` events broadcast by
      // the server would never reach project.shots, so the modal + grid would
      // stay frozen on the pre-click snapshot until a full re-fetch. That was
      // the entire reason the UI required refresh to see 'generating' /
      // 'ready' / 'error' states.
      setProject((prev) => {
        if (!prev) return prev
        const idx = prev.shots.findIndex((s) => s.idx === shot.idx)
        if (idx < 0) return prev
        const nextShots = prev.shots.slice()
        nextShots[idx] = shot
        return { ...prev, shots: nextShots }
      })
    },
  })

  const handleProjectUpdate = useCallback((p: Project) => setProject(p), [])

  const handleSettingsChange = useCallback(
    async (partial: Partial<Project>) => {
      if (!id || !project) return
      try {
        const updated = await updateProject(id, partial)
        setProject(updated)
      } catch (err) {
        toast.error('Failed to save settings', {
          description: err instanceof Error ? err.message : String(err),
        })
      }
    },
    [id, project],
  )

  const handleCharacterChange = useCallback(
    async (characterIds: string[]) => {
      if (!id || !project) return
      try {
        const updated = await updateProject(id, { characterIds })
        setProject(updated)
      } catch (err) {
        toast.error('Failed to update characters', {
          description: err instanceof Error ? err.message : String(err),
        })
      }
    },
    [id, project],
  )

  const handleReanalyze = useCallback(async () => {
    if (!id || isAnalyzing) return
    setAnalyzing(true)
    try {
      await analyzeProject(id)
    } catch (err) {
      setAnalyzing(false)
      toast.error('Could not start analysis', {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }, [id, isAnalyzing])

  const handleRemoveAudio = useCallback(async () => {
    if (!id) return
    try {
      const updated = await deleteAudio(id)
      setProject(updated)
      setAnalysis(null)
      setAnalyzing(false)
    } catch (err) {
      toast.error('Could not remove audio', {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }, [id])

  const handleReplaceAudio = useCallback(() => {
    replaceInputRef.current?.click()
  }, [])

  const handleReplaceFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      e.target.value = ''
      if (!file || !id) return
      const ext = file.name.split('.').pop()?.toLowerCase()
      if (!ext || !['mp3', 'wav'].includes(ext)) {
        toast.error('Unsupported file type', { description: 'Please upload an MP3 or WAV file.' })
        return
      }
      try {
        await uploadAudio(id, file)
        // POST /audio now clears analysis + broadcasts project:updated.
        // Re-fetch the fresh project state so we have the latest updatedAt.
        const updated = await getProject(id)
        setProject(updated)
        setAnalysis(null)
        setAudioVersion((v) => v + 1)
        toast.success('Audio replaced', { description: 'Click Regenerate Analysis to update lyrics.' })
      } catch (err) {
        toast.error('Replace failed', {
          description: err instanceof Error ? err.message : String(err),
        })
      }
    },
    [id],
  )

  const handleShotEdit = useCallback(
    (idx: number) => {
      if (!project) return
      setEditShotIdx(idx)
    },
    [project],
  )

  // Derive the live shot for the modal from the current `project.shots`. As
  // WS events update `project`, this re-derivation pushes the latest status /
  // imageUrl into the modal automatically. Closed modal -> null.
  const editShot = editShotIdx != null && project
    ? project.shots.find((s) => s.idx === editShotIdx) ?? null
    : null

  const handleShotRegenerate = useCallback((_idx: number) => {
    // Job dispatch wired by Agent D/E.
  }, [])

  // Dispatched from ShotDetailModal's CTAs. Both endpoints are still mock
  // today; once real ComfyUI image/video gen lands, the same call sites
  // become live without UI changes. The WS bus pushes the `shot:updated`
  // event so the modal reflects the new status without a re-fetch.
  const handleShotGenerateImage = useCallback(
    async (idx: number, templateName?: string) => {
      if (!id) return
      try {
        await generateShotImage(id, idx, templateName ? { templateName } : {})
      } catch (err) {
        toast.error('Failed to start image gen', {
          description: err instanceof Error ? err.message : String(err),
        })
      }
    },
    [id],
  )

  const handleGenerateAllImages = useCallback(
    async () => {
      if (!id) return
      try {
        const res = await generateAllShotImages(id)
        if (res.queued.length === 0) {
          toast.info(res.message ?? 'Nothing to generate')
        } else {
          toast.success(`Queued ${res.queued.length} shot${res.queued.length === 1 ? '' : 's'}`)
        }
      } catch (err) {
        toast.error('Failed to start batch image gen', {
          description: err instanceof Error ? err.message : String(err),
        })
      }
    },
    [id],
  )

  const handleShotGenerateVideo = useCallback(
    async (idx: number) => {
      if (!id) return
      try {
        await animateShot(id, idx)
      } catch (err) {
        toast.error('Failed to start video gen', {
          description: err instanceof Error ? err.message : String(err),
        })
      }
    },
    [id],
  )

  const handleGenerateAllVideos = useCallback(async () => {
    if (!id) return
    try {
      const res = await generateAllShotVideos(id)
      if (res.queued.length === 0) {
        toast.info(res.message ?? 'No shots eligible for video gen.')
      } else {
        toast.success(`Queued ${res.queued.length} shot video${res.queued.length === 1 ? '' : 's'}`)
      }
    } catch (err) {
      toast.error('Failed to start batch video gen', {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }, [id])

  // Chain confirm-dialog state: when shots 0..N-1 already have videos +
  // saved latents, ask the user whether to resume from N or start over from 0.
  // resumeIdx === 0 means "no completed shots" → start normally without prompt.
  // resumeIdx === shots.length means "all done" → noop with a toast.
  const [chainModal, setChainModal] = useState<{ resumeIdx: number; total: number } | null>(null)

  const fireChain = useCallback(
    async (startIdx: number) => {
      if (!id || !project) return
      const seed = project.shots[startIdx]?.imageUrl
        ?? project.shots[0]?.imageUrl
      try {
        const res = await generateChainVideos(id, {
          startIdx,
          startingImageUrl: seed,
        })
        toast.success(
          `Chain queued: ${res.shotCount} shot${res.shotCount === 1 ? '' : 's'} starting at shot ${startIdx + 1}`,
          { description: 'Shots will generate serially. WS updates each card as they progress.' },
        )
      } catch (err) {
        toast.error('Failed to start chain gen', {
          description: err instanceof Error ? err.message : String(err),
        })
      }
    },
    [id, project],
  )

  const handleGenerateChainVideos = useCallback(() => {
    if (!id || !project) return
    if (!project.shots[0]?.imageUrl) {
      toast.error('Shot 1 needs an image first', {
        description: 'Chain mode bootstraps from shot 1’s image as the first frame.',
      })
      return
    }
    // Find the highest contiguous resume point: largest N such that shots
    // 0..N-1 ALL have videoUrl. (Last-frame extraction means we only need
    // the predecessor's video to chain — no saved latent file dependency.)
    let resumeIdx = 0
    for (const s of project.shots) {
      if (s.videoUrl) {
        resumeIdx = s.idx + 1
      } else {
        break
      }
    }
    if (resumeIdx === 0) {
      // Nothing completed — fire straight away from shot 0.
      void fireChain(0)
      return
    }
    if (resumeIdx >= project.shots.length) {
      toast.info('All shots already have chained videos. Nothing to do.')
      return
    }
    // Partial completion — prompt user.
    setChainModal({ resumeIdx, total: project.shots.length })
  }, [id, project, fireChain])

  const handleShotSave = useCallback(
    async (partial: Partial<Shot>) => {
      if (!editShot || !id) return
      try {
        const updated = await updateShot(id, editShot.idx, partial)
        setProject((prev) =>
          prev
            ? {
                ...prev,
                shots: prev.shots.map((s) => (s.idx === updated.idx ? updated : s)),
              }
            : prev,
        )
      } catch (err) {
        toast.error('Failed to save shot', {
          description: err instanceof Error ? err.message : String(err),
        })
      }
      // Modal stays open: ShotDetailModal auto-saves on debounce as the user
      // types, so closing here would slam the dialog shut every ~400 ms.
      // Explicit close is owned by the modal's onClose / X-button.
    },
    [editShot, id],
  )

  // ── Loading / not-found guards ────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!project) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-4">
        <Film className="w-14 h-14 text-muted-foreground/30" />
        <p className="text-sm text-muted-foreground">Project not found.</p>
        <Button variant="secondary" onClick={() => navigate('/videoboard')}>
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to projects
        </Button>
      </div>
    )
  }

  const hasAudio = Boolean(project.audioPath)

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Hidden file input for replace-audio flow */}
      <input
        ref={replaceInputRef}
        type="file"
        accept=".mp3,.wav,audio/mpeg,audio/wav"
        className="sr-only"
        onChange={handleReplaceFileChange}
      />

      {/* ── Single header row: back + name + tabs inline ──────────────────── */}
      <div className="sticky top-12 z-40 border-b bg-muted/80 backdrop-blur">
        <div className="flex items-center gap-3 px-4 py-2">
          <button
            type="button"
            onClick={() => navigate('/videoboard')}
            className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
            aria-label="Back to projects"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>

          <h1 className="text-sm font-semibold text-foreground truncate min-w-0">
            {project.name}
          </h1>

          {/* Tabs + Regenerate — pushed to right side of header */}
          {hasAudio && (
            <div role="tablist" className="tab-strip ml-auto">
              <button
                role="tab"
                aria-selected={activeTab === 'analyze'}
                onClick={() => setActiveTab('analyze')}
                className={`tab-strip-item ${activeTab === 'analyze' ? 'is-active' : ''}`}
              >
                <Music className="w-3.5 h-3.5" />
                Analyze
              </button>
              <button
                role="tab"
                aria-selected={activeTab === 'storyboard'}
                onClick={() => setActiveTab('storyboard')}
                className={`tab-strip-item ${activeTab === 'storyboard' ? 'is-active' : ''}`}
              >
                <LayoutGrid className="w-3.5 h-3.5" />
                Storyboard
              </button>
              <button
                role="tab"
                aria-selected={activeTab === 'result'}
                onClick={() => setActiveTab('result')}
                className={`tab-strip-item ${activeTab === 'result' ? 'is-active' : ''}`}
              >
                <Film className="w-3.5 h-3.5" />
                Result
              </button>
              {/* Regenerate sits INSIDE the strip as an action — styled
                  destructive (red) so it visually reads as a heavy action,
                  not a passive nav tab. */}
              <button
                type="button"
                onClick={() => void handleReanalyze()}
                disabled={isAnalyzing}
                className="tab-strip-item text-destructive hover:bg-destructive/10"
                aria-label="Regenerate analysis"
              >
                {isAnalyzing ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Analyzing…
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-3.5 h-3.5" />
                    Regenerate
                  </>
                )}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── No-audio empty state ─────────────────────────────────────────── */}
      {!hasAudio && (
        <div className="flex-1 flex items-center justify-center">
          <Suspense fallback={<PanelFallback />}>
            <AudioPanel
              projectId={project.id}
              project={project}
              onProjectUpdate={handleProjectUpdate}
              onUploaded={() => setActiveTab('analyze')}
            />
          </Suspense>
        </div>
      )}

      {/* ── Tab content (only when audio loaded) ────────────────────────── */}
      {hasAudio && (
        <div className="flex-1 min-h-0 overflow-y-auto">
          {/* Analyze tab */}
          {activeTab === 'analyze' && (
            <div className="p-4 sm:p-6">
              <Suspense fallback={<PanelFallback />}>
                <AnalyzeView
                  project={project}
                  analysis={analysis}
                  audioVersion={audioVersion}
                  onReplaceAudio={handleReplaceAudio}
                  onRemoveAudio={() => void handleRemoveAudio()}
                  onSettingsChange={handleSettingsChange}
                  onCharacterChange={handleCharacterChange}
                  onStoryboardGenerated={() => setActiveTab('storyboard')}
                />
              </Suspense>
            </div>
          )}

          {/* Storyboard tab — clean shot grid only */}
          {activeTab === 'storyboard' && (
            <div className="flex-1 min-h-0 overflow-y-auto p-4">
              <Suspense fallback={<PanelFallback />}>
                <StoryboardGrid
                  project={project}
                  onShotEdit={handleShotEdit}
                  onShotRegenerate={handleShotRegenerate}
                  onGenerateAllImages={() => void handleGenerateAllImages()}
                  onGenerateAllVideos={() => void handleGenerateAllVideos()}
                  onGenerateChainVideos={() => void handleGenerateChainVideos()}
                />
              </Suspense>
            </div>
          )}

          {/* Result tab */}
          {activeTab === 'result' && (
            <div className="flex flex-col items-center justify-center gap-4 py-24 text-muted-foreground">
              <Film className="w-12 h-12 opacity-30" />
              <p className="text-sm">Final render not yet implemented.</p>
            </div>
          )}
        </div>
      )}

      {/* Shot detail dialog (image + video prompts, gen CTAs) */}
      <Suspense fallback={null}>
        <ShotDetailModal
          shot={editShot}
          open={editShot != null}
          onClose={() => setEditShotIdx(null)}
          onSave={handleShotSave}
          onGenerateImage={handleShotGenerateImage}
          onGenerateVideo={handleShotGenerateVideo}
          defaultTemplateName={project?.settings.imageTemplateName}
        />
      </Suspense>

      {/* Chain resume confirmation */}
      <Suspense fallback={null}>
        <ConfirmDialog
          open={chainModal != null}
          onClose={() => setChainModal(null)}
          title="Continue video chain?"
          description={
            chainModal
              ? `Shots 1–${chainModal.resumeIdx} already have chained videos. Resume from shot ${chainModal.resumeIdx + 1} of ${chainModal.total}, or start over from shot 1?`
              : ''
          }
          confirmLabel={chainModal ? `Resume from shot ${chainModal.resumeIdx + 1}` : 'Resume'}
          confirmTone="primary"
          cancelLabel="Cancel"
          onConfirm={async () => {
            const idx = chainModal?.resumeIdx ?? 0
            setChainModal(null)
            await fireChain(idx)
          }}
        >
          <button
            type="button"
            onClick={() => {
              setChainModal(null)
              void fireChain(0)
            }}
            className="mt-3 w-full text-xs text-destructive hover:underline text-left"
          >
            Start over from shot 1 (re-renders {chainModal?.resumeIdx ?? 0} existing video{chainModal?.resumeIdx === 1 ? '' : 's'})
          </button>
        </ConfirmDialog>
      </Suspense>
    </div>
  )
}
