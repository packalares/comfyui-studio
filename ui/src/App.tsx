import { Suspense, lazy, useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Spinner } from './components/ui/spinner';
import Layout from './components/layout/Layout';
import Dashboard from './pages/Dashboard';

const Explore = lazy(() => import('./pages/Explore'));
const Studio = lazy(() => import('./pages/Studio'));
const Gallery = lazy(() => import('./pages/Gallery'));
const Models = lazy(() => import('./pages/Models'));
const Plugins = lazy(() => import('./pages/Plugins'));
const Chat = lazy(() => import('./pages/Chat'));
const PluginsInstalled = lazy(() => import('./pages/plugins/Installed'));
const PluginsHistory = lazy(() => import('./pages/plugins/History'));
const PluginsPythonDependencies = lazy(() => import('./pages/plugins/python/Dependencies'));
const PluginsPythonPackages = lazy(() => import('./pages/plugins/python/Packages'));
const Packs = lazy(() => import('./pages/Packs'));
const Settings = lazy(() => import('./pages/Settings'));
const Videoboard = lazy(() => import('./pages/Videoboard'));
const VideoboardProject = lazy(() => import('./pages/VideoboardProject'));
const Characters = lazy(() => import('./pages/Characters'));
const Music = lazy(() => import('./pages/music/Music'));
const TrainLora = lazy(() => import('./pages/TrainLora'));

// Route-level Suspense fallback. Cached lazy chunks resolve in <50ms; flashing
// a spinner for them looks like a bug. Delay the reveal so only genuinely slow
// loads ever paint, and fill the route area so the spinner is centered in the
// viewport (not pinned to the top-left).
function RouteFallback() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShow(true), 250);
    return () => clearTimeout(t);
  }, []);
  if (!show) return null;
  return (
    <div className="flex items-center justify-center min-h-[60vh] w-full">
      <Spinner size="xl" className="text-muted-foreground" />
    </div>
  );
}

function App() {
  return (
    <Layout>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          {/* Templates (formerly "Explore") — the page that browses every
              available workflow. Old `/explore` URLs and `?source=civitai`
              deep-links keep working via a 1:1 redirect. */}
          <Route path="/templates" element={<Explore />} />
          <Route path="/explore" element={<Navigate to="/templates" replace />} />
          {/* Single wildcard route so navigating between bare /studio,
              /studio/easy/<tab>, and /studio/<templateName> keeps the same
              Studio instance mounted — no Suspense flash on tab clicks.
              Studio parses the splat itself (see useParams("*")). */}
          <Route path="/studio/*" element={<Studio />} />
          <Route path="/gallery" element={<Gallery />} />
          <Route path="/models" element={<Models />} />
          <Route path="/chat" element={<Chat />} />
          {/* Per-conversation deep link. Sidebar items + new-chat redirect
              both target this path; Chat.tsx reads `:chatId` via useParams
              and treats the URL as the source of truth. */}
          <Route path="/chat/c/:chatId" element={<Chat />} />
          {/* Legacy /chat/models — Ollama is now a Source filter on /models. */}
          <Route path="/chat/models" element={<Navigate to="/models?source=ollama" replace />} />
          <Route path="/plugins" element={<Plugins />}>
            <Route index element={<Navigate to="/plugins/installed" replace />} />
            <Route path="installed" element={<PluginsInstalled />} />
            <Route path="history" element={<PluginsHistory />} />
            <Route path="python">
              <Route index element={<Navigate to="/plugins/python/dependencies" replace />} />
              <Route path="dependencies" element={<PluginsPythonDependencies />} />
              <Route path="packages" element={<PluginsPythonPackages />} />
            </Route>
            {/* Legacy /plugins/civitai/* URLs — CivitAI is now a Source filter
                on the Models + Explore pages. Send stragglers to Models. */}
            <Route path="civitai/models" element={<Navigate to="/models?source=civitai" replace />} />
            <Route path="civitai/workflows" element={<Navigate to="/templates?source=civitai" replace />} />
            <Route path="civitai/*" element={<Navigate to="/plugins/installed" replace />} />
          </Route>
          {/* Splat route, same reasoning as /studio/* — Music owns its own
              Create/Library sub-routes via a nested <Routes> so tab clicks
              don't remount the page (and the player bar/audio element). */}
          <Route path="/music/*" element={<Music />} />
          <Route path="/train-lora" element={<TrainLora />} />
          <Route path="/packs" element={<Packs />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/videoboard" element={<Videoboard />} />
          <Route path="/videoboard/characters" element={<Characters />} />
          <Route path="/videoboard/:id" element={<VideoboardProject />} />
        </Routes>
      </Suspense>
    </Layout>
  );
}

export default App;
