// Music — Suno-style Create → Library → Player experience backed by
// ACE-Step. Entry point registered at `/music/*` in App.tsx.
//
// Gated behind the `ace-step` capability pack (see AppSidebar's nav entry);
// this page also self-guards in case someone deep-links here directly
// before the pack is installed.

import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate, NavLink } from 'react-router-dom';
import { PackagePlus } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import PageSubbar from '../../components/layout/PageSubbar';
import { Button } from '../../components/ui/button';
import { Spinner } from '../../components/ui/spinner';
import { cn } from '../../lib/utils';
import { MusicProvider } from './MusicContext';
import { CreateTab } from './CreateTab';
import { LibraryTab } from './LibraryTab';
import { PlayerBar } from './PlayerBar';
import { CreatePlaylistModal, AddToPlaylistModal } from './PlaylistModals';

// Train/TTS are lazy — they pull in the (fairly large) training-categories
// wizard and IndexTTS2 form, neither of which the common Create/Library path
// needs on first paint.
const TrainTab = lazy(() => import('./TrainTab'));
const TtsTab = lazy(() => import('./TtsTab'));

function TabFallback() {
  return (
    <div className="flex justify-center py-16"><Spinner size="lg" /></div>
  );
}

function NotInstalled() {
  return (
    <>
      <PageSubbar title="Music" description="Text-to-song generation powered by ACE-Step" />
      <div className="flex flex-col items-center justify-center gap-3 px-4 py-24 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <PackagePlus className="h-5 w-5" />
        </div>
        <h2 className="text-sm font-semibold text-foreground">Music (ACE-Step) isn't installed yet</h2>
        <p className="max-w-sm text-xs text-muted-foreground">
          Install the Music capability pack to generate songs, manage your library, and play them back here.
        </p>
        <Button asChild size="sm" className="mt-1">
          <NavLink to="/packs">Open Packs</NavLink>
        </Button>
      </div>
    </>
  );
}

function MusicTabs() {
  const tabClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      'tab-strip-item',
      isActive && 'is-active',
    );
  return (
    <div className="tab-strip" role="tablist">
      <NavLink to="create" className={tabClass}>Create</NavLink>
      <NavLink to="library" className={tabClass}>Library</NavLink>
      <NavLink to="train" className={tabClass}>Train</NavLink>
      <NavLink to="tts" className={tabClass}>TTS</NavLink>
    </div>
  );
}

export default function Music() {
  const { capabilities } = useApp();

  if (!capabilities['ace-step']) return <NotInstalled />;

  return (
    <MusicProvider>
      <PageSubbar title="Music" description="Text-to-song generation powered by ACE-Step" right={<MusicTabs />} />
      <div className="p-4 sm:p-6">
        <Routes>
          <Route index element={<Navigate to="create" replace />} />
          <Route path="create" element={<CreateTab />} />
          <Route path="library" element={<LibraryTab />} />
          <Route
            path="train"
            element={<Suspense fallback={<TabFallback />}><TrainTab /></Suspense>}
          />
          <Route
            path="tts"
            element={<Suspense fallback={<TabFallback />}><TtsTab /></Suspense>}
          />
          <Route path="*" element={<Navigate to="create" replace />} />
        </Routes>
      </div>
      <PlayerBar />
      <CreatePlaylistModal />
      <AddToPlaylistModal />
    </MusicProvider>
  );
}
