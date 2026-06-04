import { useEffect, useState } from 'react'
import { Check, UserCircle2, Loader2 } from 'lucide-react'
import { ScrollArea } from '../ui/scroll-area'
import { listCharacters, type Character } from '../../api/videoboard'

interface Props {
  selectedIds: string[]
  onChange: (ids: string[]) => void
  max?: number
}

export function CharacterPicker({ selectedIds, onChange, max }: Props) {
  const [characters, setCharacters] = useState<Character[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    listCharacters()
      .then(setCharacters)
      .catch(() => setCharacters([]))
      .finally(() => setLoading(false))
  }, [])

  const toggle = (id: string) => {
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter((x) => x !== id))
    } else {
      if (max != null && selectedIds.length >= max) return
      onChange([...selectedIds, id])
    }
  }

  return (
    <div>
      <p className="text-xs text-muted-foreground mb-2">
        {max != null
          ? `Select up to ${max} character${max === 1 ? '' : 's'}`
          : 'Select characters'}
        {selectedIds.length > 0 && ` · ${selectedIds.length} selected`}
      </p>
      {loading ? (
        <div className="flex items-center gap-2 py-4 text-muted-foreground text-xs">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading characters…
        </div>
      ) : characters.length === 0 ? (
        <p className="text-xs text-muted-foreground py-4 text-center">
          No characters yet. Create one in the{' '}
          <a href="/videoboard/characters" className="text-brand hover:underline">
            Characters library
          </a>
          .
        </p>
      ) : (
        <ScrollArea className="h-40">
          <div className="grid grid-cols-2 gap-2 pr-2">
            {characters.map((c) => {
              const selected = selectedIds.includes(c.id)
              const disabled = !selected && max != null && selectedIds.length >= max
              return (
                <button
                  key={c.id}
                  type="button"
                  disabled={disabled}
                  onClick={() => toggle(c.id)}
                  className={[
                    'relative flex items-center gap-2 rounded-md border px-2 py-1.5 text-left text-xs transition-colors',
                    selected
                      ? 'border-brand bg-brand/10 text-brand'
                      : 'border-border bg-card text-foreground hover:bg-muted',
                    disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer',
                  ].join(' ')}
                >
                  {c.refPhotoUrls[0] ? (
                    <img
                      src={c.refPhotoUrls[0]}
                      alt={c.name}
                      className="w-6 h-6 rounded-full object-cover shrink-0"
                    />
                  ) : (
                    <UserCircle2 className="w-6 h-6 shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate flex-1 font-medium">{c.name}</span>
                  {selected && (
                    <Check className="w-3 h-3 shrink-0 text-brand" />
                  )}
                  <span
                    className="absolute top-0.5 right-0.5 text-[9px] text-muted-foreground uppercase tracking-wider"
                  >
                    {c.kind}
                  </span>
                </button>
              )
            })}
          </div>
        </ScrollArea>
      )}
    </div>
  )
}
