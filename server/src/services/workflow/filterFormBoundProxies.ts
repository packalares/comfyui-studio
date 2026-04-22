// Drops Advanced-Settings proxy entries whose (innerNodeId, widgetName)
// matches a widget already bound to a main-form field. Keeps the main form
// as the single authoritative edit surface for bound widgets (Phase 1 dedup
// goal) — without this, proxy wrappers that re-export the main prompt's
// primitive node would double up in the UI.
//
// Raw-widget settings carry `proxyIndex: -1` (sentinel) and are left alone;
// they're already deduped against `formClaimed` inside buildRawWidgetSettings.

import { generateFormInputs } from '../templates/templates.formInputs.js';
import * as templates from '../templates/index.js';
import type { RawTemplate } from '../templates/types.js';
import type { AdvancedSetting } from '../../contracts/workflow.contract.js';

/** Build the set of "nodeId|widgetName" keys that the main form owns. */
export function computeFormBoundKeys(
  templateName: string,
  workflow: Record<string, unknown>,
  objectInfo: Record<string, Record<string, unknown>>,
): Set<string> {
  const tpl = templates.getTemplate(templateName);
  const raw: RawTemplate = {
    name: templateName,
    title: tpl?.title ?? templateName,
    description: tpl?.description ?? '',
    mediaType: tpl?.mediaType ?? 'image',
    tags: tpl?.tags ?? [],
    models: tpl?.models ?? [],
    io: tpl?.io,
  };
  const formInputs = generateFormInputs(raw, workflow, objectInfo);
  return new Set(
    formInputs
      .filter(f => f.bindNodeId && f.bindWidgetName)
      .map(f => `${f.bindNodeId}|${f.bindWidgetName}`),
  );
}

/**
 * Pure filter extracted so the dedup rule is independently unit-testable.
 * `proxyWidgets` and `settings` share an index (proxyIndex) — we look up
 * each setting's (innerNodeId, widgetName) via that index and drop it when
 * the same pair is already bound to a main-form field.
 */
export function filterProxySettingsByBoundKeys(
  settings: AdvancedSetting[],
  proxyWidgets: string[][],
  boundKeys: Set<string>,
): AdvancedSetting[] {
  return settings.filter(s => {
    // Raw-widget entries use proxyIndex === -1 as the sentinel; they're handled
    // by buildRawWidgetSettings/formClaimed, not by us.
    if (typeof s.proxyIndex !== 'number' || s.proxyIndex < 0) return true;
    const entry = proxyWidgets[s.proxyIndex];
    if (!entry) return true;
    const [innerId, widgetName] = entry;
    return !boundKeys.has(`${innerId}|${widgetName}`);
  });
}

/** Convenience wrapper used by the route — looks up the bound keys itself. */
export function filterProxySettingsAgainstForm(
  settings: AdvancedSetting[],
  proxyWidgets: string[][],
  templateName: string,
  workflow: Record<string, unknown>,
  objectInfo: Record<string, Record<string, unknown>>,
): AdvancedSetting[] {
  const boundKeys = computeFormBoundKeys(templateName, workflow, objectInfo);
  return filterProxySettingsByBoundKeys(settings, proxyWidgets, boundKeys);
}
