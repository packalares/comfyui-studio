// Merge candidates from every collector into a single deduplicated list.
//
// Three rules, applied in order:
//
//   Rule A — `(bindNodeId, bindWidgetName)` collision:
//     Two candidates point at the same physical widget. Keep the one with
//     the higher source precedence (media-upload > primitive > widget-walk
//     > proxy-promote > tag-fallback). Equal precedence: keep the first
//     one (input order is collector order, so primitive > widget-walk for
//     the rare case both walks emit the same bind).
//
//   Rule B — `id` collision but DIFFERENT bind:
//     Same logical id surfaced via two distinct widgets. Keep both, but
//     suffix the second's id with a stable hash of its bind so the UI's
//     `formValues[id]` doesn't blast both fields with the same value. The
//     label gets a scope hint so the user can tell them apart.
//
//   Rule C — widget-walk collapses into primitive:
//     A widget-walk candidate whose `bindNodeId` resolves to a Primitive*
//     class type is a logical duplicate of the primitive walk's
//     `${bindNodeId}|value` field — a Primitive's value IS the widget. Drop
//     the widget-walk candidate.
//
//   Rule D — proxy-promote yields to upstream primitive:
//     A proxy-promote candidate exposes a wrapper's proxied inner widget.
//     If a primitive candidate already publishes the same `id` (e.g. a
//     top-level Primitive titled "Prompt" driving the wire that feeds the
//     proxied inner widget), the proxy-promote is logically redundant —
//     editing the upstream primitive flows through the wire. Drop the
//     proxy-promote rather than disambiguating with a suffix.

import type { FlatNode } from '../../workflow/flatten/index.js';
import { PRIMITIVE_CLASS_TYPES } from './primitiveCandidates.js';
import type { FormFieldCandidate } from './types.js';
import { SOURCE_PRECEDENCE } from './types.js';
import type { FormInputData } from '../types.js';

function bindKeyOf(c: FormFieldCandidate): string | null {
  if (!c.bindNodeId || !c.bindWidgetName) return null;
  return `${c.bindNodeId}|${c.bindWidgetName}`;
}

/** Stable 7-char hash for id-collision suffixes. Not crypto — just unique
 *  enough that `prompt__1a2b3c4` doesn't accidentally collide with another
 *  field's authored id. */
function shortHash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36).padStart(7, '0').slice(0, 7);
}

function humanScope(bindNodeId: string | undefined): string {
  if (!bindNodeId) return '';
  const colon = bindNodeId.lastIndexOf(':');
  return colon >= 0 ? bindNodeId.slice(colon + 1) : bindNodeId;
}

/** Strip the internal `source` field before publishing to consumers. */
function publish(c: FormFieldCandidate): FormInputData {
  const { source: _source, ...rest } = c;
  void _source;
  return rest;
}

/**
 * Apply Rule C. Pre-filter: drop widget-walk candidates whose `bindNodeId`
 * resolves to a Primitive* class type AND whose primitive sibling
 * `${bindNodeId}|value` is in the candidate set.
 */
function applyRuleC(
  candidates: FormFieldCandidate[],
  flatNodes: Map<string, FlatNode>,
): FormFieldCandidate[] {
  const primitiveValueBinds = new Set<string>();
  for (const c of candidates) {
    if (c.source !== 'primitive') continue;
    if (!c.bindNodeId) continue;
    primitiveValueBinds.add(`${c.bindNodeId}|value`);
  }
  return candidates.filter(c => {
    if (c.source !== 'widget-walk') return true;
    if (!c.bindNodeId) return true;
    const node = flatNodes.get(c.bindNodeId);
    if (!node || !PRIMITIVE_CLASS_TYPES.has(node.type)) return true;
    const sibling = `${c.bindNodeId}|value`;
    return !primitiveValueBinds.has(sibling);
  });
}

/**
 * Run merge over an ordered candidate list. Returns published fields + the
 * claim set. Candidate order matters: collectors should be passed in
 * precedence order (media → primitive → widget-walk → proxy-promote)
 * because Rule A's tiebreaker is input order.
 */
export function mergeCandidates(
  candidates: FormFieldCandidate[],
  flatNodes: Map<string, FlatNode>,
): { fields: FormInputData[]; claimSet: Set<string> } {
  const filtered = applyRuleC(candidates, flatNodes);

  const byBind = new Map<string, FormFieldCandidate>();
  const idToBindKey = new Map<string, string>();
  const order: FormFieldCandidate[] = [];

  for (const raw of filtered) {
    let cand: FormFieldCandidate = { ...raw };
    const bindKey = bindKeyOf(cand);

    if (bindKey && byBind.has(bindKey)) {
      const incumbent = byBind.get(bindKey)!;
      if (SOURCE_PRECEDENCE[cand.source] > SOURCE_PRECEDENCE[incumbent.source]) {
        const idx = order.indexOf(incumbent);
        if (idx >= 0) order.splice(idx, 1);
        idToBindKey.delete(incumbent.id);
        byBind.set(bindKey, cand);
        order.push(cand);
        idToBindKey.set(cand.id, bindKey);
      }
      continue;
    }

    if (idToBindKey.has(cand.id)) {
      const existingBindKey = idToBindKey.get(cand.id)!;
      if (existingBindKey === bindKey) continue;
      // Rule D: a proxy-promote candidate yields to any earlier candidate
      // sharing its id — the earlier source (typically a primitive) is the
      // upstream surface for the proxy's wired target.
      if (cand.source === 'proxy-promote') continue;
      const suffix = shortHash(bindKey ?? cand.id);
      const newId = `${cand.id}__${suffix}`;
      const scopeHint = humanScope(cand.bindNodeId);
      cand = {
        ...cand,
        id: newId,
        label: scopeHint ? `${cand.label} (${scopeHint})` : cand.label,
      };
    }

    if (bindKey) byBind.set(bindKey, cand);
    idToBindKey.set(cand.id, bindKey ?? cand.id);
    order.push(cand);
  }

  const claimSet = new Set<string>();
  for (const c of order) {
    const k = bindKeyOf(c);
    if (k) claimSet.add(k);
  }

  return { fields: order.map(publish), claimSet };
}
