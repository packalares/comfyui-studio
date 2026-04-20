// Public barrel for the raw-widget pipeline.

export { computeFormClaimedWidgets } from './claimed.js';
export {
  buildRawWidgetSettings,
  enumerateTemplateWidgets,
} from './enumerate.js';
export {
  filteredWidgetValues,
  inferWidgetShape,
  isWidgetSpec,
  widgetNamesFor,
} from './shapes.js';
