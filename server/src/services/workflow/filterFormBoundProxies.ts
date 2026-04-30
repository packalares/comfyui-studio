// Drop Advanced-Settings proxy entries that the main form already owns.
//
// Source of truth is the `claimSet` from `buildFormFieldPlan`. When the
// main form has a bound field for a widget (compound or bare), the proxy
// version of the same widget MUST disappear from Advanced — otherwise the
// user gets two edit surfaces for one value.
//
// `proxyWidgets` carries the wrapper's authored `[innerNodeId, widgetName]`
// list; `resolvedKeys` (from `resolveProxyBoundKeys`) carries the same list
// in flattener compound-id form so we can compare to the form's
// `bindNodeId`. Both are checked; either matching is a drop.
//
// Widget-name fallback: when a wrapper proxies through a `-1` subgraph
// input port whose declared name disagrees with the consumer node's
// canonical input name (`text` vs `prompt`, etc.), the resolved widget
// name and the form's bindWidgetName diverge even though they target the
// same physical widget. The fallback compares against any claim entry on
// the resolved compound nodeId regardless of widget name — gated to the
// known prompt-surface widget set so we don't over-match unrelated knobs.

import type { AdvancedSetting } from '../../contracts/workflow.contract.js';
import { buildFormFieldPlan } from '../templates/formFieldPlan/index.js';
import * as templates from '../templates/index.js';
import { resolveProxyBoundKeys } from './proxyLabels.js';
import type { RawTemplate } from '../templates/types.js';

const PROMPT_SURFACE_WIDGET_NAMES = new Set<string>([
  'text', 'prompt',
  'positive_prompt', 'negative_prompt',
  'clip_l', 't5xxl',
  'text_g', 'text_l',
  'tags', 'lyrics',
]);

function rawTemplate(templateName: string): RawTemplate {
  const tpl = templates.getTemplate(templateName);
  return {
    name: templateName,
    title: tpl?.title ?? templateName,
    description: tpl?.description ?? '',
    mediaType: tpl?.mediaType ?? 'image',
    tags: tpl?.tags ?? [],
    models: tpl?.models ?? [],
    io: tpl?.io,
  };
}

/** Build the set of `${bindNodeId}|${bindWidgetName}` keys via the canonical
 *  plan. Same data the form sees — guaranteed in-sync. */
export function computeFormBoundKeys(
  templateName: string,
  workflow: Record<string, unknown>,
  objectInfo: Record<string, Record<string, unknown>>,
): Set<string> {
  return buildFormFieldPlan(rawTemplate(templateName), workflow, objectInfo).claimSet;
}

/**
 * Pure filter — drop a proxy AdvancedSetting whose target widget the form
 * already binds. Three independent checks, in order:
 *   1. Raw `(innerId, widgetName)` from the wrapper's proxy entry — covers
 *      legacy non-subgraph wrappers whose proxy ids are bare numeric.
 *   2. Resolved compound key from `resolveProxyBoundKeys` — covers modern
 *      subgraph wrappers using compound ids like `17:9`.
 *   3. Compound nodeId match across any prompt-surface widget name — covers
 *      the case where the subgraph-input name diverges from the consumer's
 *      canonical input name (e.g. wrapper input `text` consumed as
 *      `prompt`). Gated to PROMPT_SURFACE_WIDGET_NAMES.
 */
export function filterProxySettingsByBoundKeys(
  settings: AdvancedSetting[],
  proxyWidgets: string[][],
  boundKeys: Set<string>,
  resolvedKeys?: Array<{ nodeId: string; widgetName: string }>,
): AdvancedSetting[] {
  const boundCompoundIds = new Set<string>();
  for (const k of boundKeys) {
    const pipe = k.indexOf('|');
    if (pipe < 0) continue;
    const widget = k.slice(pipe + 1);
    if (!PROMPT_SURFACE_WIDGET_NAMES.has(widget)) continue;
    boundCompoundIds.add(k.slice(0, pipe));
  }

  return settings.filter(s => {
    if (typeof s.proxyIndex !== 'number' || s.proxyIndex < 0) return true;
    const entry = proxyWidgets[s.proxyIndex];
    if (!entry) return true;
    const [innerId, widgetName] = entry;
    if (boundKeys.has(`${innerId}|${widgetName}`)) return false;
    const resolved = resolvedKeys?.[s.proxyIndex];
    if (resolved) {
      if (boundKeys.has(`${resolved.nodeId}|${resolved.widgetName}`)) return false;
      if (PROMPT_SURFACE_WIDGET_NAMES.has(resolved.widgetName)
          && boundCompoundIds.has(resolved.nodeId)) return false;
    }
    return true;
  });
}

/** Convenience wrapper used by the route — derives boundKeys via the
 *  canonical plan in one shot. */
export function filterProxySettingsAgainstForm(
  settings: AdvancedSetting[],
  proxyWidgets: string[][],
  templateName: string,
  workflow: Record<string, unknown>,
  objectInfo: Record<string, Record<string, unknown>>,
  wrapperNode?: Record<string, unknown>,
): AdvancedSetting[] {
  const boundKeys = computeFormBoundKeys(templateName, workflow, objectInfo);
  const resolvedKeys = wrapperNode
    ? resolveProxyBoundKeys(wrapperNode, proxyWidgets, workflow)
    : undefined;
  return filterProxySettingsByBoundKeys(settings, proxyWidgets, boundKeys, resolvedKeys);
}
