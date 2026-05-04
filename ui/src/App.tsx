import { Suspense, lazy } from 'react';
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
const Settings = lazy(() => import('./pages/Settings'));

function RouteFallback() {
  return (
    <div className="flex items-center justify-center h-64">
      <Spinner size="xl" className="text-slate-400" />
    </div>
  );
}

function App() {
  return (
    <Layout>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/explore" element={<Explore />} />
          <Route path="/studio" element={<Studio />} />
          <Route path="/studio/:templateName" element={<Studio />} />
          <Route path="/gallery" element={<Gallery />} />
          <Route path="/models" element={<Models />} />
          <Route path="/chat" element={<Chat />} />
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
            <Route path="civitai/workflows" element={<Navigate to="/explore?source=civitai" replace />} />
            <Route path="civitai/*" element={<Navigate to="/plugins/installed" replace />} />
          </Route>
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </Suspense>
    </Layout>
  );
}

export default App;
