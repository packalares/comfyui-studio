// Canonical workflow / advanced-settings shapes.

export interface AdvancedSetting {
  id: string;
  label: string;
  /**
   * Human-readable context describing where this widget lives (node title
   * / class name, subgraph path). Rendered by the UI as a tooltip beside
   * the label so the primary `label` can stay short ("Duration") while
   * still disclosing scope ("TextEncodeAceStepAudio1.5" /
   * "Video Generation (LTX-2.3) · KSamplerSelect"). Optional — when
   * absent, the UI omits the tooltip affordance entirely.
   */
  scopeLabel?: string;
  type: 'number' | 'slider' | 'seed' | 'select' | 'toggle' | 'text' | 'textarea';
  value: unknown;
  min?: number;
  max?: number;
  step?: number;
  options?: { label: string; value: string }[];
  proxyIndex: number;
  /**
   * Source node id (top-level numeric or compound subgraph id `267:6`).
   * Used by the Advanced Settings UI to group settings under a per-node
   * heading so users can tell which node a control came from when many
   * widgets are exposed across multiple nodes. Optional for back-compat:
   * legacy persisted settings without an attributed node fall through to
   * an "Other" group.
   */
  nodeId?: string;
  /**
   * Display name for the source node — `node.title` when present, otherwise
   * the node's class type. Paired with `nodeId` and used as the section
   * heading text in the grouped Advanced Settings render.
   */
  nodeTitle?: string;
}

export interface EnumeratedWidget {
  nodeId: string;
  nodeType: string;
  nodeTitle?: string;
  widgetName: string;
  label: string;
  /**
   * Scope disclosure (subgraph + inner node title / class) for inner
   * widgets. Paired with `label` in the UI so callers that render the
   * field can show the widget name primary and the scope as a subtle
   * tooltip — same split as `AdvancedSetting.scopeLabel`.
   */
  scopeLabel?: string;
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
   * image/audio/video upload targets). The "Edit advanced fields" modal renders
   * these as checked + read-only so the user sees the truth ("this IS in
   * Advanced, the main form put it there") without being able to toggle off
   * something the workflow's binding owns. Other consumers (e.g. the Studio
   * page's Prompt prefill) read this to learn the template's defaults.
   */
  formClaimed: boolean;
  /**
   * True when this widget is already exposed via a wrapper subgraph's
   * `proxyWidgets` list (the workflow author's curated Advanced Settings).
   * Same UX rule as `formClaimed`: the modal renders the row checked +
   * read-only — the workflow author baked this in, the user can't toggle it
   * off without editing the workflow itself. Avoids the duplicate-row bug
   * where a proxied widget plus a user-exposed entry for the same widget
   * both render in Advanced.
   */
  proxyExposed: boolean;
  /**
   * Display name of the subgraph this widget was enumerated from. Absent for
   * top-level widgets (nodeId has no `:`). For inner-subgraph widgets whose
   * nodeId is compound (e.g. `267:216` or `267:midWrapperId:leafId`), holds
   * the definition-level name (`definitions.subgraphs[i].name`) of the scope
   * the widget physically lives in. Used by the UI to group inner widgets
   * under a heading so users can tell where buried controls came from.
   */
  scopeName?: string;
}

export interface FormInputBinding {
  id: string;
  type: string;
  nodeId?: number;
  nodeType?: string;
  mediaType?: string;
  /**
   * Prompt-surface binding emitted by the workflow-reading form-input path.
   * Instructs the generate pipeline to write this field's value onto
   * `prompt[bindNodeId].inputs[bindWidgetName]`. Distinct from `nodeId`
   * above (which is numeric, media-upload-only) because inner subgraph ids
   * are strings and per-widget routing needs the widget name.
   */
  bindNodeId?: string;
  bindWidgetName?: string;
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
