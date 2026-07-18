// Create-playlist and add-to-playlist dialogs. Ported from ace-step-ui's
// `PlaylistModals.tsx`, rebuilt on comfy's `AppModal` + form primitives.

import { useState } from 'react';
import { Music, Plus } from 'lucide-react';
import AppModal from '../../components/modals/AppModal';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Textarea } from '../../components/ui/textarea';
import { useMusic } from './MusicContext';

export function CreatePlaylistModal() {
  const { createPlaylistOpen, closeCreatePlaylist, createPlaylist } = useMusic();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);

  const close = () => {
    closeCreatePlaylist();
    setName('');
    setDescription('');
  };

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await createPlaylist(name.trim(), description.trim() || undefined);
      close();
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppModal
      open={createPlaylistOpen}
      onClose={close}
      title="New playlist"
      size="sm"
      scrollBody={false}
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button type="button" variant="secondary" onClick={close}>Cancel</Button>
          <Button type="button" onClick={() => void submit()} disabled={!name.trim() || busy}>
            <Plus className="h-3.5 w-3.5" /> Create
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Name</label>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My playlist"
            onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Description (optional)</label>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What's this playlist for?"
            className="h-20 resize-none"
          />
        </div>
      </div>
    </AppModal>
  );
}

export function AddToPlaylistModal() {
  const {
    addToPlaylistSong, closeAddToPlaylist, playlists, addSongToPlaylistById, openCreatePlaylist,
  } = useMusic();

  const song = addToPlaylistSong;

  return (
    <AppModal
      open={song !== null}
      onClose={closeAddToPlaylist}
      title={song ? `Add "${song.title}" to playlist` : 'Add to playlist'}
      size="sm"
    >
      <div className="space-y-1">
        <button
          type="button"
          className="flex w-full items-center gap-3 rounded-lg border border-dashed border-border p-3 text-left transition-colors hover:bg-muted"
          onClick={() => { closeAddToPlaylist(); openCreatePlaylist(); }}
        >
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
            <Plus className="h-4 w-4" />
          </div>
          <span className="text-sm font-medium text-foreground">Create new playlist</span>
        </button>

        {playlists.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">No playlists yet.</p>
        ) : (
          playlists.map((playlist) => (
            <button
              key={playlist.id}
              type="button"
              className="flex w-full items-center gap-3 rounded-lg p-3 text-left transition-colors hover:bg-muted"
              onClick={() => {
                if (!song) return;
                void addSongToPlaylistById(playlist.id, song.id);
                closeAddToPlaylist();
              }}
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded bg-muted text-muted-foreground">
                {playlist.coverUrl ? (
                  <img src={playlist.coverUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <Music className="h-4 w-4" />
                )}
              </div>
              <span className="truncate text-sm font-medium text-foreground">{playlist.name}</span>
            </button>
          ))
        )}
      </div>
    </AppModal>
  );
}
