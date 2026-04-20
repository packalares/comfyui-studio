// Local types for the ComfyUI lifecycle port. The frontend's `LauncherStatus`
// shape consumes `ComfyUIStatus`, so field names/types are load-bearing and
// must not drift.

export interface ComfyUIStatus {
  running: boolean;
  pid: number | null;
  uptime: string | null;
  versions: {
    comfyui: string;
    frontend: string;
    app: string;
  };
  gpuMode: string;
}

export interface ComfyUIStartResponse {
  success: boolean;
  message: string;
  pid?: number | null;
  logs?: string[];
}

export interface ComfyUIStopResponse {
  success: boolean;
  message: string;
  error?: string;
}

export interface ComfyUIResetResponse {
  success: boolean;
  message: string;
  logs?: string[];
}

export interface ComfyUILogsResponse {
  logs: string[];
  success?: boolean;
  message?: string;
}

export interface ComfyUIResetLogsResponse {
  logs: string[];
  success: boolean;
  message: string;
}

export interface ResetRequest {
  lang?: string;
  mode?: 'normal' | 'hard';
}

export const MAX_LOG_ENTRIES = 10_000;
export const VERSION_CACHE_TIMEOUT_MS = 600_000; // 10 minutes
export const RESET_LOG_FILE = 'comfyui-reset.log';
/** App version shown in status response. Kept stable across launcher + studio. */
export const APP_VERSION = '1.0.0';
