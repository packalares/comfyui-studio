// Build a Zod input schema for the `generate_image` chat tool from a
// template's form-input plan. The LLM uses this schema to decide which
// fields it can override on the user's configured default template.
//
// One field is marked REQUIRED — the prompt-shaped field picked by
// `pickPromptField`. Every other field is OPTIONAL so the model can omit
// any subset and the workflow's saved defaults take over downstream.
//
// Media-upload fields (`image`/`audio`/`video`) are intentionally omitted:
// chat tool calls can't carry binary attachments through the AI-SDK shape
// without a side-channel, and the model has no way to produce one anyway.

import { z } from 'zod';
import type { FormInputData } from '../../templates/types.js';

/** Pick the prompt-bearing field. Mirrors the rule the Studio UI uses to
 *  render the prompt textarea: first text-shaped form input. */
export function pickPromptField(fields: FormInputData[]): FormInputData | null {
  return fields.find((f) => f.type === 'text' || f.type === 'textarea') ?? null;
}

function describe(field: FormInputData): string {
  const parts: string[] = [];
  parts.push(field.label || field.id);
  if (typeof field.min === 'number' && typeof field.max === 'number') {
    parts.push(`${field.min}-${field.max}`);
  } else if (typeof field.min === 'number') {
    parts.push(`min ${field.min}`);
  } else if (typeof field.max === 'number') {
    parts.push(`max ${field.max}`);
  }
  if (field.default !== undefined) {
    parts.push(`Default: ${String(field.default)}`);
  }
  return parts.join('. ');
}

function numberSchema(field: FormInputData): z.ZodType<number> {
  // Treat steps with integer step size (default in ComfyUI INT widgets)
  // as integers so the LLM can't slip a float into seed/width/height.
  const isInt = field.step === undefined ? false : Number.isInteger(field.step) && field.step >= 1;
  let s: z.ZodNumber = isInt ? z.number().int() : z.number();
  if (typeof field.min === 'number') s = s.min(field.min);
  if (typeof field.max === 'number') s = s.max(field.max);
  return s;
}

function selectSchema(field: FormInputData): z.ZodType<string> {
  const opts = (field.options ?? [])
    .map((o) => o.value)
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
  if (opts.length >= 2) {
    return z.enum(opts as [string, ...string[]]);
  }
  return z.string();
}

function fieldSchema(field: FormInputData): z.ZodType | null {
  switch (field.type) {
    case 'text':
    case 'textarea':
      return z.string();
    case 'number':
    case 'slider':
      return numberSchema(field);
    case 'toggle':
      return z.boolean();
    case 'select':
      return selectSchema(field);
    case 'image':
    case 'audio':
    case 'video':
      // Media uploads can't be passed through the chat tool surface — the
      // LLM has no way to materialise a file. Skipped from the schema.
      return null;
    default:
      return null;
  }
}

/**
 * Build a Zod object schema from the template's form-input plan. The
 * prompt-shaped field is required; everything else is optional. Returns
 * the schema plus the picked prompt field's id (so the caller knows
 * which userInput slot to write the `prompt` value into).
 */
export function formInputsToSchema(
  fields: FormInputData[],
): { schema: z.ZodObject<z.ZodRawShape>; promptFieldId: string | null } {
  const promptField = pickPromptField(fields);
  const shape: Record<string, z.ZodType> = {};

  // Required `prompt` — always present even if the template has no
  // prompt-shaped field, so the tool surface stays uniform across templates.
  shape.prompt = z.string().min(1).describe(
    promptField
      ? `Text prompt for the image. Routed to the template's "${promptField.label || promptField.id}" field.`
      : 'Text prompt for the image. The template has no prompt-shaped field; the workflow defaults run.',
  );

  for (const field of fields) {
    if (promptField && field.id === promptField.id) continue;
    if (field.id === 'prompt') continue; // never collide with the required key
    const inner = fieldSchema(field);
    if (!inner) continue;
    shape[field.id] = inner.describe(describe(field)).optional();
  }

  return { schema: z.object(shape), promptFieldId: promptField?.id ?? null };
}
