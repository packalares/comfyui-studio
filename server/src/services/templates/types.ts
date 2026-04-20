// Shared template data shapes for the templates service split.

export interface FormInputData {
  id: string;
  label: string;
  type: 'text' | 'textarea' | 'image' | 'audio' | 'video' | 'number' | 'slider' | 'select' | 'toggle';
  required: boolean;
  description?: string;
  placeholder?: string;
  default?: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: { label: string; value: string }[];
  nodeId?: number;
  nodeType?: string;
  mediaType?: string;
}

export interface TemplateData {
  name: string;
  title: string;
  description: string;
  mediaType: string;
  mediaSubtype?: string;
  tags: string[];
  models: string[];
  category: string;
  studioCategory?: 'image' | 'video' | 'audio' | '3d' | 'tools';
  io: {
    inputs: Array<{
      nodeId: number;
      nodeType: string;
      file?: string;
      mediaType: string;
    }>;
    outputs: Array<{
      nodeId: number;
      nodeType: string;
      file: string;
      mediaType: string;
    }>;
  };
  formInputs?: FormInputData[];
  thumbnail: string[];
  thumbnailVariant?: string;
  workflow?: Record<string, unknown>;
  size?: number;
  vram?: number;
  usage?: number;
  openSource?: boolean;
  username?: string;
  date?: string;
  logos?: Array<{ provider: string | string[]; label?: string }>;
  searchRank?: number;
}

export interface RawTemplate {
  name: string;
  title: string;
  description: string;
  mediaType: string;
  mediaSubtype?: string;
  tags?: string[];
  models?: string[];
  date?: string;
  size?: number;
  vram?: number;
  usage?: number;
  openSource?: boolean;
  searchRank?: number;
  username?: string;
  thumbnail?: string[];
  thumbnailVariant?: string;
  logos?: Array<{ provider: string | string[]; label?: string }>;
  io?: {
    inputs?: Array<{
      nodeId: number;
      nodeType: string;
      file?: string;
      mediaType: string;
    }>;
    outputs?: Array<{
      nodeId: number;
      nodeType: string;
      file: string;
      mediaType: string;
    }>;
  };
}

export interface RawCategory {
  moduleName: string;
  category: string;
  icon: string;
  title: string;
  type: string;
  isEssential?: boolean;
  templates: RawTemplate[];
}
