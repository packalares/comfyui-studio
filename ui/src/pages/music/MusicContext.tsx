// Shared state for the Music page: song/playlist library + a single
// persistent `<audio>` element that backs the bottom player bar. Scoped to
// `pages/music/*` (mounted by `Music.tsx`) rather than app-wide — playback
// stops if you navigate away from `/music`, same tradeoff ComfyUI's own
// Chat/Studio pages make for page-scoped state. Promoting this to a global
// mini-player (survives navigation) is a reasonable follow-up but out of
// scope for this port.

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react';
import { toast } from 'sonner';
import * as api from '../../services/ace';
import type { Playlist, RepeatMode, Song } from '../../types/ace';
import { usePersistedState } from '../../hooks/usePersistedState';

export interface MusicContextValue {
  // Library
  songs: Song[];
  playlists: Playlist[];
  songsLoading: boolean;
  playlistsLoading: boolean;
  refreshSongs: () => Promise<Song[]>;
  refreshPlaylists: () => Promise<Playlist[]>;
  toggleFavorite: (song: Song) => Promise<void>;
  removeSong: (song: Song) => Promise<void>;
  renameSong: (song: Song, title: string) => Promise<void>;

  // Playlists
  createPlaylist: (name: string, description?: string) => Promise<Playlist>;
  deletePlaylistById: (id: string) => Promise<void>;
  addSongToPlaylistById: (playlistId: string, songId: string) => Promise<void>;
  removeSongFromPlaylistById: (playlistId: string, songId: string) => Promise<void>;

  // Add-to-playlist modal (shared trigger point for Library + Player rows)
  addToPlaylistSong: Song | null;
  openAddToPlaylist: (song: Song) => void;
  closeAddToPlaylist: () => void;
  createPlaylistOpen: boolean;
  openCreatePlaylist: () => void;
  closeCreatePlaylist: () => void;

  // Player
  queue: Song[];
  currentIndex: number | null;
  currentSong: Song | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  repeatMode: RepeatMode;
  shuffle: boolean;
  playSong: (song: Song, queue?: Song[]) => void;
  togglePlay: () => void;
  next: () => void;
  previous: () => void;
  seek: (time: number) => void;
  setVolume: (v: number) => void;
  cycleRepeat: () => void;
  toggleShuffle: () => void;
}

const MusicContext = createContext<MusicContextValue | null>(null);

export function useMusic(): MusicContextValue {
  const ctx = useContext(MusicContext);
  if (!ctx) throw new Error('useMusic must be used within MusicProvider');
  return ctx;
}

export function MusicProvider({ children }: { children: ReactNode }) {
  const [songs, setSongs] = useState<Song[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [songsLoading, setSongsLoading] = useState(true);
  const [playlistsLoading, setPlaylistsLoading] = useState(true);

  const [addToPlaylistSong, setAddToPlaylistSong] = useState<Song | null>(null);
  const [createPlaylistOpen, setCreatePlaylistOpen] = useState(false);

  const refreshSongs = useCallback(async (): Promise<Song[]> => {
    setSongsLoading(true);
    try {
      const list = await api.listSongs({ limit: 200 });
      setSongs(list);
      return list;
    } catch (err) {
      toast.error('Failed to load songs', { description: err instanceof Error ? err.message : String(err) });
      return [];
    } finally {
      setSongsLoading(false);
    }
  }, []);

  const refreshPlaylists = useCallback(async (): Promise<Playlist[]> => {
    setPlaylistsLoading(true);
    try {
      const list = await api.listPlaylists();
      setPlaylists(list);
      return list;
    } catch (err) {
      toast.error('Failed to load playlists', { description: err instanceof Error ? err.message : String(err) });
      return [];
    } finally {
      setPlaylistsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshSongs();
    void refreshPlaylists();
  }, [refreshSongs, refreshPlaylists]);

  // ---- Player state -------------------------------------------------------

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [queue, setQueue] = useState<Song[]>([]);
  const [currentIndex, setCurrentIndex] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolumeState] = usePersistedState<number>('ace:volume', 1);
  const [repeatMode, setRepeatMode] = usePersistedState<RepeatMode>('ace:repeat', 'none');
  const [shuffle, setShuffle] = usePersistedState<boolean>('ace:shuffle', false);

  const currentSong = currentIndex !== null ? (queue[currentIndex] ?? null) : null;

  const pickNextIndex = useCallback((fromIndex: number, dir: 1 | -1): number | null => {
    if (queue.length === 0) return null;
    if (shuffle) {
      if (queue.length === 1) return 0;
      let idx = fromIndex;
      while (idx === fromIndex) idx = Math.floor(Math.random() * queue.length);
      return idx;
    }
    const next = fromIndex + dir;
    if (next >= 0 && next < queue.length) return next;
    if (repeatMode === 'all') return dir === 1 ? 0 : queue.length - 1;
    return null;
  }, [queue.length, shuffle, repeatMode]);

  const advance = useCallback((reason: 'ended' | 'manual') => {
    setCurrentIndex((prev) => {
      if (prev === null) return prev;
      if (reason === 'ended' && repeatMode === 'one') {
        const el = audioRef.current;
        if (el) { el.currentTime = 0; void el.play(); }
        return prev;
      }
      const next = pickNextIndex(prev, 1);
      return next ?? prev;
    });
  }, [pickNextIndex, repeatMode]);

  // The mount-only effect below registers a single `ended` listener on the
  // audio element for the component's lifetime — it can't close over
  // `advance` directly (that would freeze repeat/shuffle behaviour at
  // whatever they were on first mount). Bridge through a ref that always
  // points at the latest `advance` so the listener stays live.
  const advanceRef = useRef(advance);
  useEffect(() => { advanceRef.current = advance; }, [advance]);

  // Own the <audio> element here (not in the visual PlayerBar) so playback
  // state is a single source of truth shared by Create (auto-preview after
  // generation) and Library (click-to-play) alike.
  useEffect(() => {
    const el = document.createElement('audio');
    el.preload = 'metadata';
    audioRef.current = el;
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onTime = () => setCurrentTime(el.currentTime);
    const onLoaded = () => setDuration(el.duration || 0);
    const onEnded = () => advanceRef.current('ended');
    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('loadedmetadata', onLoaded);
    el.addEventListener('ended', onEnded);
    return () => {
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('loadedmetadata', onLoaded);
      el.removeEventListener('ended', onEnded);
      el.pause();
      el.src = '';
    };
  }, []);

  useEffect(() => {
    const el = audioRef.current;
    if (el) el.volume = volume;
  }, [volume]);

  // Load + play whenever the current song changes.
  useEffect(() => {
    const el = audioRef.current;
    if (!el || !currentSong?.audioUrl) return;
    if (el.src !== new URL(currentSong.audioUrl, window.location.href).href) {
      el.src = currentSong.audioUrl;
    }
    void el.play().catch(() => { /* autoplay may be blocked; user can hit play */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSong?.id]);

  const playSong = useCallback((song: Song, list?: Song[]) => {
    const nextQueue = list ?? [song];
    const idx = nextQueue.findIndex((s) => s.id === song.id);
    setQueue(nextQueue);
    setCurrentIndex(idx >= 0 ? idx : 0);
  }, []);

  const togglePlay = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (!currentSong) return;
    if (el.paused) void el.play();
    else el.pause();
  }, [currentSong]);

  const next = useCallback(() => advance('manual'), [advance]);

  const previous = useCallback(() => {
    const el = audioRef.current;
    if (el && el.currentTime > 3) {
      el.currentTime = 0;
      return;
    }
    setCurrentIndex((prev) => {
      if (prev === null) return prev;
      const prevIdx = pickNextIndex(prev, -1);
      return prevIdx ?? prev;
    });
  }, [pickNextIndex]);

  const seek = useCallback((time: number) => {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = time;
    setCurrentTime(time);
  }, []);

  const setVolume = useCallback((v: number) => setVolumeState(Math.max(0, Math.min(1, v))), [setVolumeState]);

  const cycleRepeat = useCallback(() => {
    setRepeatMode((m) => (m === 'none' ? 'all' : m === 'all' ? 'one' : 'none'));
  }, [setRepeatMode]);

  const toggleShuffle = useCallback(() => setShuffle((s) => !s), [setShuffle]);

  // ---- Library mutations ---------------------------------------------------

  const toggleFavorite = useCallback(async (song: Song) => {
    const updated = await api.setSongFavorite(song.id, !song.favorite);
    setSongs((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    setQueue((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
  }, []);

  const removeSong = useCallback(async (song: Song) => {
    await api.deleteSong(song.id);
    setSongs((prev) => prev.filter((s) => s.id !== song.id));
    setQueue((prev) => {
      const idx = prev.findIndex((s) => s.id === song.id);
      if (idx === -1) return prev;
      const nextQueue = prev.filter((s) => s.id !== song.id);
      setCurrentIndex((ci) => {
        if (ci === null) return ci;
        if (idx < ci) return ci - 1;
        if (idx === ci) {
          const el = audioRef.current;
          if (el) el.pause();
          return nextQueue.length === 0 ? null : Math.min(ci, nextQueue.length - 1);
        }
        return ci;
      });
      return nextQueue;
    });
    toast.success('Song deleted');
  }, []);

  const renameSong = useCallback(async (song: Song, title: string) => {
    const updated = await api.updateSong(song.id, { title });
    setSongs((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    setQueue((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
  }, []);

  const createPlaylistFn = useCallback(async (name: string, description?: string) => {
    const { playlist } = await api.createPlaylist(name, description);
    setPlaylists((prev) => [playlist, ...prev]);
    toast.success(`Playlist "${name}" created`);
    return playlist;
  }, []);

  const deletePlaylistById = useCallback(async (id: string) => {
    await api.deletePlaylist(id);
    setPlaylists((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const addSongToPlaylistById = useCallback(async (playlistId: string, songId: string) => {
    await api.addSongToPlaylist(playlistId, songId);
    toast.success('Added to playlist');
  }, []);

  const removeSongFromPlaylistById = useCallback(async (playlistId: string, songId: string) => {
    await api.removeSongFromPlaylist(playlistId, songId);
  }, []);

  const openAddToPlaylist = useCallback((song: Song) => setAddToPlaylistSong(song), []);
  const closeAddToPlaylist = useCallback(() => setAddToPlaylistSong(null), []);
  const openCreatePlaylist = useCallback(() => setCreatePlaylistOpen(true), []);
  const closeCreatePlaylist = useCallback(() => setCreatePlaylistOpen(false), []);

  const value = useMemo<MusicContextValue>(() => ({
    songs, playlists, songsLoading, playlistsLoading,
    refreshSongs, refreshPlaylists, toggleFavorite, removeSong, renameSong,
    createPlaylist: createPlaylistFn, deletePlaylistById, addSongToPlaylistById, removeSongFromPlaylistById,
    addToPlaylistSong, openAddToPlaylist, closeAddToPlaylist,
    createPlaylistOpen, openCreatePlaylist, closeCreatePlaylist,
    queue, currentIndex, currentSong, isPlaying, currentTime, duration, volume, repeatMode, shuffle,
    playSong, togglePlay, next, previous, seek, setVolume, cycleRepeat, toggleShuffle,
  }), [
    songs, playlists, songsLoading, playlistsLoading,
    refreshSongs, refreshPlaylists, toggleFavorite, removeSong, renameSong,
    createPlaylistFn, deletePlaylistById, addSongToPlaylistById, removeSongFromPlaylistById,
    addToPlaylistSong, openAddToPlaylist, closeAddToPlaylist,
    createPlaylistOpen, openCreatePlaylist, closeCreatePlaylist,
    queue, currentIndex, currentSong, isPlaying, currentTime, duration, volume, repeatMode, shuffle,
    playSong, togglePlay, next, previous, seek, setVolume, cycleRepeat, toggleShuffle,
  ]);

  return <MusicContext.Provider value={value}>{children}</MusicContext.Provider>;
}
