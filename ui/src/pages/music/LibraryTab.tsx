// Library — a gallery of your songs, not a settings table. Ported from
// ace-step-ui's `LibraryView.tsx` + `SongList.tsx`, rebuilt on comfy's
// Tabs/Card/Input primitives and the app's established gallery-tile visual
// language (see `SongCard.tsx` / `components/cards/GalleryTile.tsx`).
//
// Grid of `SongCard` tiles at `sm:` and up; a plain `SongRow` list below
// that (narrow viewports — a multi-column grid doesn't have room to breathe
// on a phone-width screen, so it collapses to a list there instead).

import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft, Heart, ListMusic, Music, Plus, Search, Sparkles, Trash2,
} from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { Card, CardContent } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../components/ui/tabs';
import { Spinner } from '../../components/ui/spinner';
import { AlbumCover } from './AlbumCover';
import { SongCard } from './SongCard';
import { SongRow } from './SongRow';
import { useMusic } from './MusicContext';
import { getPlaylist } from '../../services/ace';
import type { Playlist, Song } from '../../types/ace';

/** Responsive song collection: a `SongCard` gallery grid at `sm:` and up,
 *  a `SongRow` list below that. Both branches render (one hidden via CSS,
 *  not unmounted) so the layout doesn't pop on resize. */
function SongCollection({
  songs, emptyIcon: EmptyIcon = Music, emptyTitle, emptyHint, emptyAction,
}: {
  songs: Song[];
  emptyIcon?: typeof Music;
  emptyTitle: string;
  emptyHint?: string;
  emptyAction?: React.ReactNode;
}) {
  const {
    currentSong, isPlaying, playSong, toggleFavorite, openAddToPlaylist, renameSong, removeSong,
  } = useMusic();

  if (songs.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-16 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <EmptyIcon className="h-5 w-5" />
        </div>
        <h3 className="text-sm font-semibold text-foreground">{emptyTitle}</h3>
        {emptyHint && <p className="max-w-xs text-xs text-muted-foreground">{emptyHint}</p>}
        {emptyAction}
      </div>
    );
  }

  return (
    <>
      <div className="hidden gap-4 sm:grid sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {songs.map((song) => (
          <SongCard
            key={song.id}
            song={song}
            isCurrent={currentSong?.id === song.id}
            isPlaying={isPlaying}
            onPlay={() => playSong(song, songs)}
            onToggleFavorite={() => void toggleFavorite(song)}
            onAddToPlaylist={() => openAddToPlaylist(song)}
            onRename={(title) => void renameSong(song, title)}
            onDelete={() => void removeSong(song)}
          />
        ))}
      </div>
      <div className="space-y-0.5 sm:hidden">
        {songs.map((song, idx) => (
          <SongRow
            key={song.id}
            song={song}
            index={idx}
            isCurrent={currentSong?.id === song.id}
            isPlaying={isPlaying}
            onPlay={() => playSong(song, songs)}
            onToggleFavorite={() => void toggleFavorite(song)}
            onAddToPlaylist={() => openAddToPlaylist(song)}
            onRename={(title) => void renameSong(song, title)}
            onDelete={() => void removeSong(song)}
          />
        ))}
      </div>
    </>
  );
}

function PlaylistDetail({ playlist, onBack }: { playlist: Playlist; onBack: () => void }) {
  const { removeSongFromPlaylistById, deletePlaylistById } = useMusic();
  const [songs, setSongs] = useState<Song[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getPlaylist(playlist.id).then((res) => {
      if (!cancelled) setSongs(res.songs);
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [playlist.id]);

  const {
    currentSong, isPlaying, playSong, toggleFavorite, openAddToPlaylist, renameSong,
  } = useMusic();

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon-sm" aria-label="Back" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        {playlist.coverUrl ? (
          <img src={playlist.coverUrl} alt="" className="h-12 w-12 rounded object-cover" />
        ) : (
          <AlbumCover seed={playlist.id} size="md" />
        )}
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-foreground">{playlist.name}</h2>
          <p className="truncate text-xs text-muted-foreground">
            {playlist.description || `${songs.length} song${songs.length === 1 ? '' : 's'}`}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-destructive"
          aria-label="Delete playlist"
          onClick={() => { void deletePlaylistById(playlist.id); onBack(); }}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      {loading ? (
        <div className="flex justify-center py-10"><Spinner size="lg" /></div>
      ) : songs.length === 0 ? (
        <div className="py-10 text-center text-sm text-muted-foreground">No songs in this playlist yet.</div>
      ) : (
        <div className="space-y-0.5">
          {songs.map((song, idx) => (
            <SongRow
              key={song.id}
              song={song}
              index={idx}
              isCurrent={currentSong?.id === song.id}
              isPlaying={isPlaying}
              onPlay={() => playSong(song, songs)}
              onToggleFavorite={() => void toggleFavorite(song)}
              onAddToPlaylist={() => openAddToPlaylist(song)}
              onRename={(title) => void renameSong(song, title)}
              onDelete={() => {
                void removeSongFromPlaylistById(playlist.id, song.id);
                setSongs((prev) => prev.filter((s) => s.id !== song.id));
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function LibraryTab() {
  const { songs, playlists, songsLoading, playlistsLoading, openCreatePlaylist } = useMusic();
  const [query, setQuery] = useState('');
  const [selectedPlaylist, setSelectedPlaylist] = useState<Playlist | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return songs;
    return songs.filter((s) =>
      s.title.toLowerCase().includes(q)
      || (s.style ?? '').toLowerCase().includes(q)
      || (s.caption ?? '').toLowerCase().includes(q));
  }, [songs, query]);

  const favorites = useMemo(() => filtered.filter((s) => s.favorite), [filtered]);

  if (selectedPlaylist) {
    return (
      <Card>
        <CardContent className="pt-4">
          <PlaylistDetail playlist={selectedPlaylist} onBack={() => setSelectedPlaylist(null)} />
        </CardContent>
      </Card>
    );
  }

  const firstRunEmpty = !songsLoading && songs.length === 0;

  return (
    <Card>
      <CardContent className="space-y-4 pt-4">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search your songs…"
              className="pl-8"
              disabled={firstRunEmpty}
            />
          </div>
        </div>

        {firstRunEmpty ? (
          <div className="flex flex-col items-center gap-3 py-20 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-brand/10 text-brand">
              <Music className="h-6 w-6" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-foreground">Your library is empty</h2>
              <p className="mx-auto mt-1 max-w-xs text-xs text-muted-foreground">
                Generate your first song and it'll land here automatically — playable the moment it's ready.
              </p>
            </div>
            <Button asChild className="mt-1">
              <NavLink to="/music/create">
                <Sparkles className="h-3.5 w-3.5" /> Create a song
              </NavLink>
            </Button>
          </div>
        ) : (
          <Tabs defaultValue="all">
            <div className="flex items-center justify-between gap-2">
              <TabsList>
                <TabsTrigger value="all">All songs</TabsTrigger>
                <TabsTrigger value="favorites">Favorites</TabsTrigger>
                <TabsTrigger value="playlists">Playlists</TabsTrigger>
              </TabsList>
              <Button variant="secondary" size="sm" onClick={openCreatePlaylist}>
                <Plus className="h-3.5 w-3.5" /> New playlist
              </Button>
            </div>

            <TabsContent value="all" className="mt-4">
              {songsLoading ? (
                <div className="flex justify-center py-10"><Spinner size="lg" /></div>
              ) : (
                <SongCollection
                  songs={filtered}
                  emptyTitle="No matches"
                  emptyHint="Nothing in your library matches that search."
                />
              )}
            </TabsContent>

            <TabsContent value="favorites" className="mt-4">
              <SongCollection
                songs={favorites}
                emptyIcon={Heart}
                emptyTitle="No favorites yet"
                emptyHint="Tap the heart on a song to pin it here."
              />
            </TabsContent>

            <TabsContent value="playlists" className="mt-4">
              {playlistsLoading ? (
                <div className="flex justify-center py-10"><Spinner size="lg" /></div>
              ) : playlists.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-16 text-center text-sm text-muted-foreground">
                  <ListMusic className="h-8 w-8 opacity-40" />
                  No playlists yet.
                  <Button variant="secondary" size="sm" onClick={openCreatePlaylist}>
                    <Plus className="h-3.5 w-3.5" /> New playlist
                  </Button>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                  {playlists.map((playlist) => (
                    <button
                      key={playlist.id}
                      type="button"
                      className="group rounded-lg border border-border p-3 text-left transition-colors hover:bg-muted"
                      onClick={() => setSelectedPlaylist(playlist)}
                    >
                      <div className="mb-3 aspect-square overflow-hidden rounded-md">
                        {playlist.coverUrl ? (
                          <img src={playlist.coverUrl} alt="" className="h-full w-full object-cover" />
                        ) : (
                          <AlbumCover seed={playlist.id} size="full" />
                        )}
                      </div>
                      <div className="truncate text-sm font-medium text-foreground">{playlist.name}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {playlist.description || 'Playlist'}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </TabsContent>
          </Tabs>
        )}
      </CardContent>
    </Card>
  );
}

export default LibraryTab;
