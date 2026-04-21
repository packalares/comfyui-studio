import React, { createContext, useContext, useState, useRef } from 'react';
import type { SystemStats, MonitorStats, LauncherStatus } from '../types';

export interface SystemContextType {
  systemStats: SystemStats | null;
  monitorStats: MonitorStats | null;
  connected: boolean;
  loading: boolean;
  launcherStatus: LauncherStatus | null;
  apiKeyConfigured: boolean;
  hfTokenConfigured: boolean;
  civitaiTokenConfigured: boolean;
  uploadMaxBytes: number;
  // Internal setters/refs exposed to sibling providers (Ws, façade).
  _setConnected: React.Dispatch<React.SetStateAction<boolean>>;
  _setMonitorStats: React.Dispatch<React.SetStateAction<MonitorStats | null>>;
  _setSystemStats: React.Dispatch<React.SetStateAction<SystemStats | null>>;
  _setLauncherStatus: React.Dispatch<React.SetStateAction<LauncherStatus | null>>;
  _setLoading: React.Dispatch<React.SetStateAction<boolean>>;
  _setApiKeyConfigured: React.Dispatch<React.SetStateAction<boolean>>;
  _setHfTokenConfigured: React.Dispatch<React.SetStateAction<boolean>>;
  _setCivitaiTokenConfigured: React.Dispatch<React.SetStateAction<boolean>>;
  _setUploadMaxBytes: React.Dispatch<React.SetStateAction<number>>;
  _systemStatsRef: React.MutableRefObject<SystemStats | null>;
}

const SystemContext = createContext<SystemContextType | null>(null);

export function SystemProvider({ children }: { children: React.ReactNode }) {
  const [systemStats, setSystemStats] = useState<SystemStats | null>(null);
  const [monitorStats, setMonitorStats] = useState<MonitorStats | null>(null);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [launcherStatus, setLauncherStatus] = useState<LauncherStatus | null>(null);
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false);
  const [hfTokenConfigured, setHfTokenConfigured] = useState(false);
  const [civitaiTokenConfigured, setCivitaiTokenConfigured] = useState(false);
  // Fallback matches the server's default until `/api/system` arrives.
  const [uploadMaxBytes, setUploadMaxBytes] = useState(500 * 1024 * 1024);
  const systemStatsRef = useRef<SystemStats | null>(null);

  return (
    <SystemContext.Provider
      value={{
        systemStats,
        monitorStats,
        connected,
        loading,
        launcherStatus,
        apiKeyConfigured,
        hfTokenConfigured,
        civitaiTokenConfigured,
        uploadMaxBytes,
        _setConnected: setConnected,
        _setMonitorStats: setMonitorStats,
        _setSystemStats: setSystemStats,
        _setLauncherStatus: setLauncherStatus,
        _setLoading: setLoading,
        _setApiKeyConfigured: setApiKeyConfigured,
        _setHfTokenConfigured: setHfTokenConfigured,
        _setCivitaiTokenConfigured: setCivitaiTokenConfigured,
        _setUploadMaxBytes: setUploadMaxBytes,
        _systemStatsRef: systemStatsRef,
      }}
    >
      {children}
    </SystemContext.Provider>
  );
}

export function useSystem() {
  const ctx = useContext(SystemContext);
  if (!ctx) throw new Error('useSystem must be used within SystemProvider');
  return ctx;
}
