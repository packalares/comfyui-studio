// Generic list section for any markdown-backed library (souls, skills, commands).
// Replicates the visual structure of SoulsSection: Card with a header row
// (icon + title + badge + refresh/new ButtonGroup) and a per-row edit hover.
// Callers specialise via props — no logic lives here, only layout.

import type { ReactNode, ComponentType } from 'react';
import { Plus, RefreshCw, Pencil } from 'lucide-react';
import { Card, CardContent, CardHeader } from '../../ui/card';
import { Button } from '../../ui/button';
import { ButtonGroup } from '../../ui/button-group';
import { Badge } from '../../ui/badge';
import type { LibraryItem } from './types';

export interface MarkdownLibrarySectionProps {
  title: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  /** Badge icon shown next to the count badge when items exist. */
  badgeIcon?: ComponentType<{ className?: string }>;
  /** Singular noun for the count badge (e.g. "soul", "skill"). */
  noun: string;
  /** Error message to display, or null. */
  error: string | null;
  loading: boolean;
  items: LibraryItem[];
  onRefresh: () => void;
  onCreate: () => void;
  onEdit: (name: string) => void;
  /** Optional extra badge per item row (e.g. "default" on the default soul). */
  itemBadge?: (item: LibraryItem) => ReactNode;
  /** Optional content rendered above the card (e.g. PendingEditsCard). */
  above?: ReactNode;
  /** Label on the "create" button. Defaults to "New {noun}". */
  createLabel?: string;
}

export default function MarkdownLibrarySection({
  title,
  description,
  icon: Icon,
  badgeIcon: BadgeIcon,
  noun,
  error,
  loading,
  items,
  onRefresh,
  onCreate,
  onEdit,
  itemBadge,
  above,
  createLabel,
}: MarkdownLibrarySectionProps) {
  const newLabel = createLabel ?? `New ${noun}`;

  return (
    <>
      {above}

      <Card>
        <CardHeader className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2">
            <Icon className="w-3.5 h-3.5 text-muted-foreground mt-0.5" />
            <div>
              <h2 className="text-sm font-semibold text-foreground leading-tight">{title}</h2>
              <p className="mt-0.5 text-[11px] text-muted-foreground">{description}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {!loading && items.length > 0 && (
              <Badge variant="slate">
                {BadgeIcon && <BadgeIcon className="h-3 w-3" />}
                {items.length} {items.length === 1 ? noun : `${noun}s`}
              </Badge>
            )}
            <ButtonGroup>
              <Button
                variant="secondary"
                onClick={onRefresh}
                disabled={loading}
                aria-label={`Refresh ${noun}s`}
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                Refresh
              </Button>
              <Button onClick={onCreate}>
                <Plus className="h-3.5 w-3.5" />
                {newLabel}
              </Button>
            </ButtonGroup>
          </div>
        </CardHeader>

        <CardContent className="space-y-3">
          {error && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2">
              <p className="text-xs text-destructive">{error}</p>
            </div>
          )}

          {loading ? (
            <div className="space-y-2">
              {[1, 2, 3].map(i => (
                <div key={i} className="h-14 rounded-lg bg-muted animate-pulse" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed bg-muted/40 px-4 py-6 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <Icon className="h-6 w-6" />
              </div>
              <p className="text-sm text-muted-foreground max-w-sm">
                No {noun}s yet. Create one to get started.
              </p>
              <Button onClick={onCreate}>
                <Plus className="h-3.5 w-3.5" />
                {newLabel}
              </Button>
            </div>
          ) : (
            <div className="divide-y rounded-lg border overflow-hidden">
              {items.map(item => (
                <div
                  key={item.name}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-muted transition-colors group"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-foreground font-mono">
                        {item.name}
                      </span>
                      {itemBadge?.(item)}
                    </div>
                    {item.description && (
                      <p className="mt-0.5 text-xs text-muted-foreground truncate">
                        {item.description}
                      </p>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Edit ${noun} ${item.name}`}
                    onClick={() => onEdit(item.name)}
                    className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
