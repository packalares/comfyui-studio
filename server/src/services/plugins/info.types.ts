// Public plugin metadata types shared across plugin service modules.

export interface VersionInfo {
  id: string;
  version: string;
  changelog?: string;
  createdAt: string;
  deprecated: boolean;
  downloadUrl?: string;
  node_id: string;
  status: string;
  dependencies?: string[];
  supported_accelerators?: string[] | null;
  supported_comfyui_frontend_version?: string;
  supported_comfyui_version?: string;
  supported_os?: string[] | null;
}

export interface PluginMetadata {
  id: string;
  name: string;
  description: string;
  author: string;
  repository: string;
  version: string;
  latest_version?: VersionInfo;
  versions?: VersionInfo[];
  status: string;
  status_detail?: string;
  rating: number;
  downloads: number;
  github_stars: number;
  icon?: string;
  banner_url?: string;
  category?: string;
  license?: string;
  tags?: string[];
  dependencies?: string[];
  requirements?: string[];
  supported_accelerators?: string[] | null;
  supported_comfyui_frontend_version?: string;
  supported_comfyui_version?: string;
  supported_os?: string[] | null;
  created_at: string;
  lastModified?: string;
  installed: boolean;
  installedOn?: string;
  disabled: boolean;
  hasInstallScript?: boolean;
  hasRequirementsFile?: boolean;
  size?: number;
}
