// Canonical workflow / advanced-settings shapes.

export interface AdvancedSetting {
  id: string;
  label: string;
  type: 'number' | 'slider' | 'seed' | 'select' | 'toggle' | 'text' | 'textarea';
  value: unknown;
  min?: number;
  max?: number;
  step?: number;
  options?: { label: string; value: string }[];
  proxyIndex: number;
}

export interface EnumeratedWidget {
  nodeId: string;
  nodeType: string;
  nodeTitle?: string;
  widgetName: string;
  label: string;
  value: unknown;
  type: AdvancedSetting['type'];
  min?: number;
  max?: number;
  step?: number;
  options?: { label: string; value: string }[];
  /** True when the user has already opted to expose this widget in Advanced Settings. */
  exposed: boolean;
  /**
   * True when this widget is already driven by the main form (positive prompt,
   * image/audio/video upload targets). The "Edit advanced fields" modal hides
   * these so the user can't expose duplicates; other consumers (e.g. the
   * Studio page's Prompt prefill) read them to learn the template's defaults.
   */
  formClaimed: boolean;
}

export interface FormInputBinding {
  id: string;
  type: string;
  nodeId?: number;
  nodeType?: string;
  mediaType?: string;
}

export interface WorkflowNode {
  type?: string;
  class_type?: string;
  properties?: {
    models?: Array<{ name: string; url: string; directory: string }>;
    [key: string]: unknown;
  };
  widgets_values?: unknown[];
  [key: string]: unknown;
}
