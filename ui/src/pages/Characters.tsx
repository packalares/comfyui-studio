import { useCallback, useEffect, useRef, useState } from 'react'
import { UserCircle2, Plus, Trash2, Loader2, Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import PageSubbar from '../components/layout/PageSubbar'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '../components/ui/dialog'
import { Input } from '../components/ui/input'
import {
  listCharacters,
  createCharacter,
  deleteCharacter,
  type Character,
} from '../api/videoboard'

const KIND_LABELS: Record<Character['kind'], string> = {
  pulid: 'PuLID (instant)',
  lora: 'LoRA (trained)',
}

const BASE_MODEL_LABELS: Record<Character['baseModel'], string> = {
  'flux2-klein': 'FLUX.2 Klein',
  'flux1-dev': 'FLUX.1 Dev',
  sdxl: 'SDXL',
}

function CharacterCard({
  character,
  onDeleted,
}: {
  character: Character
  onDeleted: (id: string) => void
}) {
  const [deleting, setDeleting] = useState(false)

  const handleDelete = async () => {
    setDeleting(true)
    try {
      await deleteCharacter(character.id)
      onDeleted(character.id)
      toast.success(`Deleted "${character.name}"`)
    } catch (err) {
      toast.error('Delete failed', {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="card overflow-hidden flex flex-col group">
      {/* Photo strip */}
      <div className="aspect-square relative flex items-center justify-center overflow-hidden bg-muted">
        {character.refPhotoUrls[0] ? (
          <img
            src={character.refPhotoUrls[0]}
            alt={character.name}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <UserCircle2 className="w-12 h-12 text-muted-foreground/40" />
        )}
        {character.refPhotoUrls.length > 1 && (
          <span className="absolute bottom-1 right-1 text-[10px] bg-popover/90 rounded px-1 py-0.5 text-muted-foreground">
            +{character.refPhotoUrls.length - 1}
          </span>
        )}
        <div className="absolute top-1 right-1 flex gap-1">
          <Badge variant="neutral">{character.kind}</Badge>
        </div>
      </div>

      {/* Info */}
      <div className="p-3 flex flex-col flex-1">
        <p className="text-sm font-semibold text-foreground line-clamp-1 mb-1">{character.name}</p>
        <p className="text-[11px] text-muted-foreground mb-3">
          {BASE_MODEL_LABELS[character.baseModel]}
        </p>
        <div className="mt-auto">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="w-full"
            disabled={deleting}
            onClick={() => void handleDelete()}
          >
            {deleting ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Trash2 className="w-3 h-3" />
            )}
            {deleting ? 'Deleting…' : 'Delete'}
          </Button>
        </div>
      </div>
    </div>
  )
}

interface CreateForm {
  name: string
  kind: Character['kind']
  baseModel: Character['baseModel']
  files: File[]
}

const INITIAL_FORM: CreateForm = {
  name: '',
  kind: 'pulid',
  baseModel: 'flux1-dev',
  files: [],
}

export default function Characters() {
  const [characters, setCharacters] = useState<Character[]>([])
  const [loading, setLoading] = useState(true)
  const [activeKind, setActiveKind] = useState<Character['kind']>('pulid')
  const [createOpen, setCreateOpen] = useState(false)
  const [form, setForm] = useState<CreateForm>(INITIAL_FORM)
  const [creating, setCreating] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setCharacters(await listCharacters())
    } catch (err) {
      toast.error('Failed to load characters', {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const visible = characters.filter((c) => c.kind === activeKind)

  const handleCreate = async () => {
    const name = form.name.trim()
    if (!name) return
    if (form.files.length === 0) {
      toast.error('Please add at least one reference photo.')
      return
    }
    setCreating(true)
    try {
      const c = await createCharacter({
        name,
        kind: form.kind,
        baseModel: form.baseModel,
        refPhotos: form.files,
      })
      setCharacters((prev) => [c, ...prev])
      setCreateOpen(false)
      setForm(INITIAL_FORM)
      toast.success(`Character "${c.name}" created`)
    } catch (err) {
      toast.error('Failed to create character', {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setCreating(false)
    }
  }

  const addFiles = (newFiles: FileList | File[]) => {
    const accepted = Array.from(newFiles).filter((f) =>
      f.type.startsWith('image/'),
    )
    setForm((prev) => ({ ...prev, files: [...prev.files, ...accepted] }))
  }

  const removeFile = (idx: number) => {
    setForm((prev) => ({ ...prev, files: prev.files.filter((_, i) => i !== idx) }))
  }

  return (
    <>
      <PageSubbar
        title="Characters"
        description="Reference faces for music-video generation"
        right={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="w-3.5 h-3.5" />
            Create Character
          </Button>
        }
      />

      <div className="p-4 sm:p-6">
        {/* Kind tabs */}
        <div role="tablist" className="tab-strip mb-6">
          {(['pulid', 'lora'] as const).map((k) => (
            <button
              key={k}
              role="tab"
              aria-selected={activeKind === k}
              onClick={() => setActiveKind(k)}
              className={`tab-strip-item ${activeKind === k ? 'is-active' : ''}`}
            >
              {KIND_LABELS[k]}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-24 gap-2 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin" />
            <span className="text-sm">Loading…</span>
          </div>
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 gap-4">
            <UserCircle2 className="w-14 h-14 text-muted-foreground/30" />
            <p className="text-sm font-medium text-muted-foreground">
              No {KIND_LABELS[activeKind]} characters yet
            </p>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="w-3.5 h-3.5" />
              Create Character
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
            {visible.map((c) => (
              <CharacterCard
                key={c.id}
                character={c}
                onDeleted={(id) =>
                  setCharacters((prev) => prev.filter((x) => x.id !== id))
                }
              />
            ))}
          </div>
        )}
      </div>

      {/* Create Character dialog */}
      <Dialog
        open={createOpen}
        onOpenChange={(v) => {
          setCreateOpen(v)
          if (!v) setForm(INITIAL_FORM)
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Create Character</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Name */}
            <div>
              <label className="field-label mb-1.5 block text-sm" htmlFor="char-name">
                Name
              </label>
              <Input
                id="char-name"
                placeholder="Character name"
                value={form.name}
                onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                autoFocus
              />
            </div>

            {/* Kind toggle */}
            <div>
              <label className="field-label mb-1.5 block text-sm">Type</label>
              <div role="tablist" className="tab-strip w-full">
                {(['pulid', 'lora'] as const).map((k) => (
                  <button
                    key={k}
                    role="tab"
                    type="button"
                    aria-selected={form.kind === k}
                    onClick={() => setForm((prev) => ({ ...prev, kind: k }))}
                    className={`tab-strip-item flex-1 ${form.kind === k ? 'is-active' : ''}`}
                  >
                    {KIND_LABELS[k]}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {form.kind === 'pulid'
                  ? 'PuLID locks identity instantly — no training needed.'
                  : 'LoRA trains a personalized adapter for higher fidelity.'}
              </p>
            </div>

            {/* Base model */}
            <div>
              <label className="field-label mb-1.5 block text-sm" htmlFor="base-model">
                Base model
              </label>
              <select
                id="base-model"
                value={form.baseModel}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    baseModel: e.target.value as Character['baseModel'],
                  }))
                }
                className="w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-brand/40"
              >
                {(
                  [
                    ['flux2-klein', BASE_MODEL_LABELS['flux2-klein']],
                    ['flux1-dev', BASE_MODEL_LABELS['flux1-dev']],
                    ['sdxl', BASE_MODEL_LABELS['sdxl']],
                  ] as const
                ).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </div>

            {/* Dropzone */}
            <div>
              <label className="field-label mb-1.5 block text-sm">
                Reference photos
              </label>
              <div
                role="button"
                tabIndex={0}
                aria-label="Drop reference photos here"
                className={[
                  'rounded-lg border-2 border-dashed transition-colors p-6 text-center cursor-pointer',
                  dragOver
                    ? 'border-brand bg-brand/5'
                    : 'border-border hover:border-brand/50 hover:bg-muted/50',
                ].join(' ')}
                onClick={() => fileInputRef.current?.click()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click()
                }}
                onDragOver={(e) => {
                  e.preventDefault()
                  setDragOver(true)
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault()
                  setDragOver(false)
                  if (e.dataTransfer.files) addFiles(e.dataTransfer.files)
                }}
              >
                <Upload className="w-6 h-6 text-muted-foreground/50 mx-auto mb-2" />
                <p className="text-sm text-muted-foreground">
                  Drop images here or <span className="text-brand">browse</span>
                </p>
                <p className="text-[11px] text-muted-foreground mt-1">
                  JPG, PNG, WEBP — multiple allowed
                </p>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) addFiles(e.target.files)
                  e.target.value = ''
                }}
              />

              {form.files.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {form.files.map((f, i) => (
                    <div key={`${f.name}-${i}`} className="relative group/thumb">
                      <img
                        src={URL.createObjectURL(f)}
                        alt={f.name}
                        className="w-14 h-14 object-cover rounded-md border"
                      />
                      <button
                        type="button"
                        onClick={() => removeFile(i)}
                        className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-destructive text-primary-foreground flex items-center justify-center opacity-0 group-hover/thumb:opacity-100 transition-opacity"
                        aria-label={`Remove ${f.name}`}
                      >
                        <X className="w-2.5 h-2.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => {
                setCreateOpen(false)
                setForm(INITIAL_FORM)
              }}
              disabled={creating}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void handleCreate()}
              disabled={!form.name.trim() || form.files.length === 0 || creating}
            >
              {creating ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Creating…
                </>
              ) : (
                'Create Character'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
