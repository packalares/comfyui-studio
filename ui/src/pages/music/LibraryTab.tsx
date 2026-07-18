// Library — song list, favorites, and playlists. Ported from ace-step-ui's
// `LibraryView.tsx` + `SongList.tsx`, rebuilt on comfy's Tabs/Card/Input.

import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Music, Plus, Search, Trash2 } from 'lucide-react';
import { Card, CardContent } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../components/ui/tabs';
import { Spinner } from '../../components/ui/spinner';
import { AlbumCover } from './AlbumCover';
import { SongRow } from './SongRow';
import { useMusic } from './MusicContext';
import { getPlaylist } from '../../services/ace';
import type { Playlist, Song } from '../../types/ace';

function SongListPanel({
  songs, emptyLabel,
}: { songs: Song[]; emptyLabel: string }) {
  const {
    currentSong, isPlaying, playSong, toggleFavorite, openAddToPlaylist, renameSong, removeSong,
  } = useMusic();

  if (songs.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-16 text-center text-sm text-muted-foreground">
        <Music className="h-8 w-8 opacity-40" />
        {emptyLabel}
      </div>
    );
  }

  return (
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
          onDelete={() => void removeSong(song)}
        />
      ))}
    </div>
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
            />
          </div>
        </div>

        <Tabs defaultValue="all">
          <div className="flex items-center justify-between">
            <TabsList>
              <TabsTrigger value="all">All songs</TabsTrigger>
              <TabsTrigger value="favorites">Favorites</TabsTrigger>
              <TabsTrigger value="playlists">Playlists</TabsTrigger>
            </TabsList>
            <Button variant="secondary" size="sm" onClick={openCreatePlaylist}>
              <Plus className="h-3.5 w-3.5" /> New playlist
            </Button>
          </div>

          <TabsContent value="all" className="mt-3">
            {songsLoading ? (
              <div className="flex justify-center py-10"><Spinner size="lg" /></div>
            ) : (
              <SongListPanel songs={filtered} emptyLabel="No songs yet. Head to Create to make your first one." />
            )}
          </TabsContent>

          <TabsContent value="favorites" className="mt-3">
            <SongListPanel songs={favorites} emptyLabel="No favorites yet — tap the heart on a song to pin it here." />
          </TabsContent>

          <TabsContent value="playlists" className="mt-3">
            {playlistsLoading ? (
              <div className="flex justify-center py-10"><Spinner size="lg" /></div>
            ) : playlists.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-16 text-center text-sm text-muted-foreground">
                <Music className="h-8 w-8 opacity-40" />
                No playlists yet.
                <Button variant="secondary" size="sm" onClick={openCreatePlaylist}>
                  <Plus className="h-3.5 w-3.5" /> New playlist
                </Button>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
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
      </CardContent>
    </Card>
  );
}

export default LibraryTab;
