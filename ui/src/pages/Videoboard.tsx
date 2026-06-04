import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Film, Plus, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import PageSubbar from '../components/layout/PageSubbar'
import { Button } from '../components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '../components/ui/dialog'
import { Input } from '../components/ui/input'
import { VideoboardProjectCard } from '../components/videoboard/VideoboardProjectCard'
import { createProject, listProjects, type Project } from '../api/videoboard'

export default function Videoboard() {
  const navigate = useNavigate()
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [newOpen, setNewOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setProjects(await listProjects())
    } catch (err) {
      toast.error('Failed to load projects', {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const handleCreate = async () => {
    const name = newName.trim()
    if (!name) return
    setCreating(true)
    try {
      const p = await createProject(name)
      setNewOpen(false)
      setNewName('')
      navigate(`/videoboard/${p.id}`)
    } catch (err) {
      toast.error('Failed to create project', {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setCreating(false)
    }
  }

  return (
    <>
      <PageSubbar
        title="Videoboard"
        description="Music-video projects"
        right={
          <Button onClick={() => setNewOpen(true)}>
            <Plus className="w-3.5 h-3.5" />
            New Project
          </Button>
        }
      />

      <div className="p-4 sm:p-6">
        {loading ? (
          <div className="flex items-center justify-center py-24 gap-2 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin" />
            <span className="text-sm">Loading projects…</span>
          </div>
        ) : projects.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 gap-4">
            <Film className="w-14 h-14 text-muted-foreground/30" />
            <p className="text-sm font-medium text-muted-foreground">No projects yet</p>
            <p className="text-xs text-muted-foreground">
              Create your first music-video project to get started.
            </p>
            <Button onClick={() => setNewOpen(true)}>
              <Plus className="w-3.5 h-3.5" />
              New Project
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {projects.map((p) => (
              <VideoboardProjectCard
                key={p.id}
                project={p}
                onDeleted={(id) => setProjects((prev) => prev.filter((x) => x.id !== id))}
              />
            ))}
          </div>
        )}
      </div>

      {/* New Project dialog */}
      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New Project</DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <label className="field-label mb-1.5 block text-sm" htmlFor="project-name">
              Project name
            </label>
            <Input
              id="project-name"
              placeholder="My Music Video"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCreate()
              }}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setNewOpen(false)} disabled={creating}>
              Cancel
            </Button>
            <Button onClick={() => void handleCreate()} disabled={!newName.trim() || creating}>
              {creating ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Creating…
                </>
              ) : (
                'Create'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
