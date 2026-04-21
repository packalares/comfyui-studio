import { useState, useMemo, useCallback, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { useNavigate } from 'react-router-dom';
import {
  Download, Trash2, X,
  Image as ImageIcon, Video, Music, ArrowRight, SlidersHorizontal,
  LayoutGrid, CheckSquare, AlertCircle, DownloadCloud, Loader2,
} from 'lucide-react';
import type { GalleryItem } from '../types';
import { api } from '../services/comfyui';
import { usePersistedState } from '../hooks/usePersistedState';
import { usePaginated } from '../hooks/usePaginated';
import Pagination from '../components/Pagination';
import PageSubbar from '../components/PageSubbar';
import GalleryTile from '../components/GalleryTile';
import GalleryDetailModal from '../components/GalleryDetailModal';
import ConfirmDialog from '../components/ConfirmDialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Checkbox } from '../components/ui/checkbox';

type FilterType = 'all' | 'image' | 'video' | 'audio';
type SortBy = 'newest' | 'oldest';

/** Pending-delete descriptor. `single` + `ids` are mutually exclusive; the
 *  single variant maps 1:1 to the per-item trash-can, bulk to the toolbar. */
type DeleteRequest =
  | { kind: 'single'; id: string }
  | { kind: 'bulk'; ids: string[] };

export default function Gallery() {
  const navigate = useNavigate();

  const [filter, setFilter] = usePersistedState<FilterType>('gallery.filter', 'all');
  const [sortBy, setSortBy] = usePersistedState<SortBy>('gallery.sortBy', 'newest');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [viewItem, setViewItem] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = usePersistedState('gallery.filtersOpen', false);
  const [onlyFavorites, setOnlyFavorites] = usePersistedState('gallery.onlyFavorites', false);
  const [favorites, setFavorites] = useState<Set<string>>(() => {
    const saved = localStorage.getItem('comfyui-studio-favorites');
    return saved ? new Set(JSON.parse(saved)) : new Set();
  });
  const [pendingDelete, setPendingDelete] = useState<DeleteRequest | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Wave F: explicit "import from ComfyUI history" confirm + result banner.
  const [importConfirmOpen, setImportConfirmOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);

  // Server-paginated: media-type + sort apply globally; favorites stay
  // client-side (localStorage) so they filter the current page only.
  const fetcher = useCallback(
    async ({ page, pageSize }: { page: number; pageSize: number }) => {
      const res = await api.getGalleryPaged(page, pageSize, {
        mediaType: filter !== 'all' ? filter : undefined,
        sort: sortBy,
      });
      return { items: res.items, total: res.total, hasMore: res.hasMore };
    },
    [filter, sortBy],
  );
  const paged = usePaginated<GalleryItem>(fetcher, { deps: [filter, sortBy] });
  const { items: pageItems, refetch } = paged;

  // Refetch when a generation completes. The backend appends the row + emits
  // a `gallery` WS broadcast; AppContext surfaces that as an updated
  // `galleryTotal` which we watch here.
  const { galleryTotal } = useApp();
  useEffect(() => {
    void refetch();
  }, [galleryTotal, refetch]);

  const filteredGallery = useMemo(() => {
    if (!onlyFavorites) return pageItems;
    return pageItems.filter((item) => favorites.has(item.id));
  }, [pageItems, onlyFavorites, favorites]);

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleFavorite = (id: string) => {
    setFavorites(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      localStorage.setItem('comfyui-studio-favorites', JSON.stringify([...next]));
      return next;
    });
  };

  const selectAll = () => {
    if (selectedIds.size === filteredGallery.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredGallery.map(i => i.id)));
    }
  };

  const bulkSelecting = selectedIds.size > 0;

  // Drive the AlertDialog off `pendingDelete` so the same confirm path backs
  // both the per-item trash-can and the bulk toolbar.
  const openDeleteForItem = (id: string) => {
    setDeleteError(null);
    setPendingDelete({ kind: 'single', id });
  };
  const openDeleteForSelection = () => {
    if (selectedIds.size === 0) return;
    setDeleteError(null);
    setPendingDelete({ kind: 'bulk', ids: [...selectedIds] });
  };

  const runDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      if (pendingDelete.kind === 'single') {
        const res = await api.deleteGalleryItem(pendingDelete.id);
        if (!res.deleted) throw new Error(`Could not delete ${pendingDelete.id}`);
        // Drop from selection in case the toolbar was open on this id.
        setSelectedIds(prev => {
          const next = new Set(prev);
          next.delete(pendingDelete.id);
          return next;
        });
        // Close the viewer modal if it was showing the deleted item.
        if (viewItem === pendingDelete.id) setViewItem(null);
      } else {
        const res = await api.bulkDeleteGalleryItems(pendingDelete.ids);
        const failed = res.results.filter(r => !r.removed);
        setSelectedIds(new Set());
        if (failed.length > 0) {
          setDeleteError(
            `Deleted ${res.deleted} of ${res.requested}. ` +
            `${failed.length} failed: ${failed.slice(0, 3).map(f => f.id).join(', ')}` +
            `${failed.length > 3 ? '…' : ''}`,
          );
        }
      }
      await refetch();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeleting(false);
      setPendingDelete(null);
    }
  };

  const pendingCount = pendingDelete
    ? (pendingDelete.kind === 'single' ? 1 : pendingDelete.ids.length)
    : 0;

  const runImport = useCallback(async () => {
    setImporting(true);
    setImportResult(null);
    try {
      const res = await api.importGalleryFromComfyUI();
      setImportResult(
        `Imported ${res.imported} item${res.imported === 1 ? '' : 's'}` +
        (res.skipped > 0 ? ` (${res.skipped} already present)` : '') + '.',
      );
      await refetch();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Import failed';
      setImportResult(msg);
    } finally {
      setImporting(false);
      setImportConfirmOpen(false);
    }
  }, [refetch]);

  return (
    <>
      <PageSubbar
        title="Gallery"
        description={`${paged.total} generations`}
        right={
          bulkSelecting ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500">{selectedIds.size} selected</span>
              <button className="btn-secondary">
                <Download className="w-3.5 h-3.5" />
                Download
              </button>
              <button
                onClick={openDeleteForSelection}
                className="btn-secondary text-red-600 border-red-200 hover:bg-red-50"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Delete
              </button>
              <button
                onClick={() => setSelectedIds(new Set())}
                className="btn-icon"
                aria-label="Clear selection"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <>
              <button
                onClick={() => { setImportResult(null); setImportConfirmOpen(true); }}
                className="btn-secondary"
                disabled={importing}
                title="Import items from ComfyUI's history"
              >
                {importing
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <DownloadCloud className="w-3.5 h-3.5" />}
                Import
              </button>
              <button
                onClick={() => setFiltersOpen(o => !o)}
                className="btn-secondary lg:hidden"
                aria-label="Toggle filters"
              >
                <SlidersHorizontal className="w-3.5 h-3.5" />
                Filters
              </button>
            </>
          )
        }
      />
      <div className="page-container">
        <div className="panel">
          <div className="flex flex-col lg:flex-row min-h-[calc(100vh-180px)]">
            {/* ===== Left sidebar ===== */}
            <aside className={`${filtersOpen ? 'block' : 'hidden'} lg:block w-full lg:w-72 shrink-0 border-b lg:border-b-0 lg:border-r border-slate-200 p-4 space-y-5 bg-white`}>
              {/* Media Type filter */}
              <div>
                <label className="field-label mb-1.5 block">Media Type</label>
                <div className="btn-group w-full">
                  {([
                    { key: 'all', label: 'All', icon: LayoutGrid },
                    { key: 'image', label: 'Image', icon: ImageIcon },
                    { key: 'video', label: 'Video', icon: Video },
                    { key: 'audio', label: 'Audio', icon: Music },
                  ] as { key: FilterType; label: string; icon: React.ComponentType<{ className?: string }> }[]).map(({ key, label, icon: Icon }) => (
                    <button
                      key={key}
                      onClick={() => setFilter(key)}
                      className={`flex-1 justify-center ${filter === key ? 'btn-primary' : 'btn-secondary'}`}
                      title={label}
                    >
                      <Icon className="w-3.5 h-3.5" />
                    </button>
                  ))}
                </div>
              </div>

              {/* Sort order */}
              <div>
                <label className="field-label mb-1.5 block">Sort by</label>
                <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortBy)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="newest">Newest first</SelectItem>
                    <SelectItem value="oldest">Oldest first</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Favorites toggle */}
              <div>
                <label className="field-label mb-1.5 block">Show</label>
                <label className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer select-none">
                  <Checkbox checked={onlyFavorites} onCheckedChange={(v) => setOnlyFavorites(v === true)} />
                  Favorites only
                </label>
              </div>

              {/* Selection actions */}
              <div className="pt-4 border-t border-slate-200">
                <label className="field-label mb-1.5 block">Selection</label>
                <button onClick={selectAll} className="btn-secondary w-full justify-center">
                  {selectedIds.size === filteredGallery.length && filteredGallery.length > 0 ? (
                    <><X className="w-3.5 h-3.5" />Deselect All</>
                  ) : (
                    <><CheckSquare className="w-3.5 h-3.5" />Select All</>
                  )}
                </button>
              </div>

              {/* Stats */}
              <div className="pt-4 border-t border-slate-200">
                <label className="field-label mb-3 block">Stats</label>
                <div className="grid grid-cols-2 gap-2">
                  <div className="stat-box bg-slate-50 ring-slate-200">
                    <p className="stat-box-label text-slate-500">Total</p>
                    <p className="stat-box-value text-slate-700">{paged.total}</p>
                  </div>
                  <div className="stat-box bg-amber-50 ring-amber-100">
                    <p className="stat-box-label text-amber-700/70">Favorites</p>
                    <p className="stat-box-value text-amber-700">{favorites.size}</p>
                  </div>
                </div>
              </div>
            </aside>

            {/* ===== Right content ===== */}
            <main className="flex-1 p-4 overflow-y-auto">
              {deleteError && (
                <div className="mb-3 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  <div className="flex-1">{deleteError}</div>
                  <button
                    onClick={() => setDeleteError(null)}
                    className="p-0.5 text-red-600 hover:text-red-800"
                    aria-label="Dismiss error"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
              {importResult && (
                <div className="mb-3 flex items-start gap-2 rounded-lg border border-teal-200 bg-teal-50 px-3 py-2 text-xs text-teal-700">
                  <DownloadCloud className="w-4 h-4 mt-0.5 shrink-0" />
                  <div className="flex-1">{importResult}</div>
                  <button
                    onClick={() => setImportResult(null)}
                    className="p-0.5 text-teal-600 hover:text-teal-800"
                    aria-label="Dismiss"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
              {filteredGallery.length > 0 ? (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                  {filteredGallery.map(item => (
                    <GalleryTile
                      key={item.id}
                      item={item}
                      isSelected={selectedIds.has(item.id)}
                      isFav={favorites.has(item.id)}
                      onOpen={() => setViewItem(item.id)}
                      onToggleSelect={() => toggleSelect(item.id)}
                      onToggleFavorite={() => toggleFavorite(item.id)}
                      onDelete={() => openDeleteForItem(item.id)}
                    />
                  ))}
                </div>
              ) : (
                <div className="text-center py-20">
                  <ImageIcon className="w-12 h-12 text-slate-200 mx-auto mb-3" />
                  <p className="text-sm font-medium text-slate-500">
                    {onlyFavorites ? 'No favorites yet' : 'No generations yet'}
                  </p>
                  <p className="text-xs text-slate-400 mt-1 mb-4">
                    {onlyFavorites
                      ? 'Mark items as favorite to see them here'
                      : 'Your generated images, videos, and audio will appear here'}
                  </p>
                  {!onlyFavorites && (
                    <div className="flex items-center justify-center gap-2">
                      <button
                        onClick={() => navigate('/studio')}
                        className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-teal-600 rounded-lg hover:bg-teal-700 transition-colors"
                      >
                        Start Creating
                        <ArrowRight className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => { setImportResult(null); setImportConfirmOpen(true); }}
                        disabled={importing}
                        className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors disabled:opacity-50"
                      >
                        {importing
                          ? <Loader2 className="w-4 h-4 animate-spin" />
                          : <DownloadCloud className="w-4 h-4" />}
                        Import from ComfyUI history
                      </button>
                    </div>
                  )}
                </div>
              )}

              <div className="mt-4">
                <Pagination
                  page={paged.page}
                  pageSize={paged.pageSize}
                  total={paged.total}
                  hasMore={paged.hasMore}
                  onPageChange={paged.setPage}
                  onPageSizeChange={paged.setPageSize}
                  className="rounded-lg border border-slate-200 bg-slate-50"
                />
              </div>
            </main>
          </div>
        </div>
      </div>

      {/* Full-size viewer modal — Wave F redesign with metadata + regenerate. */}
      {viewItem && (() => {
        const found = filteredGallery.find(i => i.id === viewItem);
        if (!found) {
          // The row disappeared under us (e.g. deleted in another tab). Bail.
          setViewItem(null);
          return null;
        }
        return (
          <GalleryDetailModal
            item={found}
            onClose={() => setViewItem(null)}
            onDelete={() => openDeleteForItem(found.id)}
            onRegenerated={() => {
              // Close the modal; the fresh prompt's outputs will stream in
              // via the normal WS gallery broadcast path and the refetch below.
              setViewItem(null);
              void refetch();
            }}
          />
        );
      })()}

      {/* Delete confirm — backs both per-item + bulk flows. */}
      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => { if (!deleting) setPendingDelete(null); }}
        title={pendingCount === 1 ? 'Delete 1 item?' : `Delete ${pendingCount} items?`}
        description="Files on disk are permanently removed. This cannot be undone."
        confirmLabel={deleting ? 'Deleting…' : 'Delete'}
        confirmTone="danger"
        busy={deleting}
        onConfirm={runDelete}
      />

      {/* Wave F: confirm before pulling ComfyUI history — the warning
          about resurrected-deletes matches the service's INSERT OR IGNORE
          semantics. */}
      <ConfirmDialog
        open={importConfirmOpen}
        onClose={() => { if (!importing) setImportConfirmOpen(false); }}
        title="Import from ComfyUI history?"
        description="Pull generated items from ComfyUI's history into your gallery? Items you've previously deleted in Studio may reappear."
        confirmLabel={importing ? 'Importing…' : 'Import'}
        busy={importing}
        onConfirm={runImport}
      />
    </>
  );
}
