import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Film, MoreHorizontal, Trash2, Clock } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '../ui/button'
import { Badge } from '../ui/badge'
import { deleteProject, type Project } from '../../api/videoboard'

interface Props {
  project: Project
  onDeleted: (id: string) => void
}

const STATUS_VARIANT = {
  draft: 'neutral',
  generating: 'warning',
  ready: 'success',
  error: 'danger',
} as const satisfies Record<Project['status'], string>

function formatAge(ts: number): string {
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

export function VideoboardProjectCard({ project, onDeleted }: Props) {
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const handleCardClick = () => navigate(`/videoboard/${project.id}`)

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation()
    setMenuOpen(false)
    setDeleting(true)
    try {
      await deleteProject(project.id)
      onDeleted(project.id)
      toast.success(`Deleted "${project.name}"`)
    } catch (err) {
      toast.error('Delete failed', {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleCardClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          handleCardClick()
        }
      }}
      className="card text-left group cursor-pointer overflow-hidden flex flex-col h-full relative"
    >
      {/* Thumbnail / placeholder */}
      <div className="aspect-video shrink-0 relative flex items-center justify-center overflow-hidden bg-muted">
        {project.shots.find((s) => s.imageUrl) ? (
          <img
            src={project.shots.find((s) => s.imageUrl)!.imageUrl}
            alt={project.name}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Film className="w-10 h-10 text-muted-foreground/40 group-hover:text-muted-foreground transition-colors" />
          </div>
        )}

        {/* Status badge + menu */}
        <div className="absolute top-2 right-2 flex items-center gap-1.5">
          <Badge variant={STATUS_VARIANT[project.status]}>{project.status}</Badge>
        </div>
        <div
          className="absolute top-2 left-2"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="relative">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="!bg-popover/90 hover:!bg-popover ring-1 ring-border"
              aria-label="Project actions"
              onClick={(e) => {
                e.stopPropagation()
                setMenuOpen((v) => !v)
              }}
            >
              <MoreHorizontal className="w-4 h-4" />
            </Button>
            {menuOpen && (
              <div
                role="menu"
                className="absolute top-9 left-0 z-10 min-w-[10rem] rounded-md border bg-popover shadow-lg p-1"
              >
                <button
                  type="button"
                  role="menuitem"
                  disabled={deleting}
                  onClick={handleDelete}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  {deleting ? 'Deleting…' : 'Delete project'}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Info */}
      <div className="p-4 flex flex-col flex-1">
        <h3 className="font-semibold text-sm text-foreground group-hover:text-brand transition-colors line-clamp-1 mb-1">
          {project.name}
        </h3>
        <div className="mt-auto flex items-center gap-3 text-[11px] text-muted-foreground">
          <span>{project.shots.length} shots</span>
          {project.audioDurationMs != null && (
            <span>{Math.round(project.audioDurationMs / 1000)}s audio</span>
          )}
          <span className="ml-auto flex items-center gap-1">
            <Clock className="w-3 h-3" />
            {formatAge(project.updatedAt)}
          </span>
        </div>
      </div>
    </div>
  )
}
