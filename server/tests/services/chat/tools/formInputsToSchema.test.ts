// Unit tests for the form-inputs → Zod schema helper that backs the
// `generate_image` chat tool. Validates the field-type mapping table from
// the chat-tool overhaul: prompt becomes required, every other field
// optional, media uploads skipped, numeric bounds preserved.

import { describe, expect, it } from 'vitest';
import { formInputsToSchema, pickPromptField } from '../../../../src/services/chat/tools/formInputsToSchema.js';
import type { FormInputData } from '../../../../src/services/templates/types.js';

function field(over: Partial<FormInputData> & Pick<FormInputData, 'id' | 'type'>): FormInputData {
  return { label: over.id, required: false, ...over };
}

describe('pickPromptField', () => {
  it('returns the first text-shaped field', () => {
    const fields = [
      field({ id: 'seed', type: 'number' }),
      field({ id: 'prompt', type: 'textarea' }),
      field({ id: 'negative_prompt', type: 'textarea' }),
    ];
    expect(pickPromptField(fields)?.id).toBe('prompt');
  });

  it('returns null when no text-shaped field exists', () => {
    const fields = [field({ id: 'seed', type: 'number' })];
    expect(pickPromptField(fields)).toBeNull();
  });
});

describe('formInputsToSchema', () => {
  it('makes prompt required and every other field optional', () => {
    const fields: FormInputData[] = [
      field({ id: 'positive', type: 'textarea', label: 'Positive prompt' }),
      field({ id: 'negative_prompt', type: 'textarea' }),
      field({ id: 'steps', type: 'number', min: 1, max: 100, default: 30, step: 1 }),
      field({ id: 'cfg', type: 'number', min: 1, max: 30, default: 7.5 }),
    ];
    const { schema, promptFieldId } = formInputsToSchema(fields);
    expect(promptFieldId).toBe('positive');

    // Required: prompt.
    const missing = schema.safeParse({});
    expect(missing.success).toBe(false);

    // Just prompt is enough.
    const minimal = schema.safeParse({ prompt: 'a cat' });
    expect(minimal.success).toBe(true);

    // Optional fields accept overrides.
    const full = schema.safeParse({
      prompt: 'a cat',
      negative_prompt: 'blurry',
      steps: 50,
      cfg: 6.5,
    });
    expect(full.success).toBe(true);
  });

  it('rejects out-of-range numbers and non-integer steps', () => {
    const fields: FormInputData[] = [
      field({ id: 'prompt', type: 'textarea' }),
      field({ id: 'steps', type: 'number', min: 1, max: 100, step: 1 }),
      field({ id: 'cfg', type: 'number', min: 1, max: 30, step: 0.1 }),
    ];
    const { schema } = formInputsToSchema(fields);

    expect(schema.safeParse({ prompt: 'x', steps: 999 }).success).toBe(false);
    expect(schema.safeParse({ prompt: 'x', steps: 0 }).success).toBe(false);
    // step=1 → integer enforcement
    expect(schema.safeParse({ prompt: 'x', steps: 1.5 }).success).toBe(false);
    expect(schema.safeParse({ prompt: 'x', steps: 50 }).success).toBe(true);
    // cfg is non-integer (step 0.1) → floats allowed.
    expect(schema.safeParse({ prompt: 'x', cfg: 6.7 }).success).toBe(true);
  });

  it('skips media-upload fields entirely', () => {
    const fields: FormInputData[] = [
      field({ id: 'prompt', type: 'textarea' }),
      field({ id: 'image_0', type: 'image' }),
      field({ id: 'video_0', type: 'video' }),
      field({ id: 'audio_0', type: 'audio' }),
    ];
    const { schema } = formInputsToSchema(fields);
    // Even if the model emits an image arg, the schema either ignores it or
    // strips it — what matters is that the schema accepts the basic prompt.
    const out = schema.safeParse({ prompt: 'x' });
    expect(out.success).toBe(true);
    if (out.success) {
      expect(out.data.image_0).toBeUndefined();
      expect(out.data.video_0).toBeUndefined();
      expect(out.data.audio_0).toBeUndefined();
    }
  });

  it('emits z.enum for select fields with options', () => {
    const fields: FormInputData[] = [
      field({ id: 'prompt', type: 'textarea' }),
      field({
        id: 'sampler',
        type: 'select',
        options: [
          { label: 'Euler', value: 'euler' },
          { label: 'DPM++ 2M', value: 'dpmpp_2m' },
        ],
      }),
    ];
    const { schema } = formInputsToSchema(fields);
    expect(schema.safeParse({ prompt: 'x', sampler: 'euler' }).success).toBe(true);
    expect(schema.safeParse({ prompt: 'x', sampler: 'made_up' }).success).toBe(false);
  });

  it('handles toggle fields as booleans', () => {
    const fields: FormInputData[] = [
      field({ id: 'prompt', type: 'textarea' }),
      field({ id: 'high_detail', type: 'toggle', default: false }),
    ];
    const { schema } = formInputsToSchema(fields);
    expect(schema.safeParse({ prompt: 'x', high_detail: true }).success).toBe(true);
    expect(schema.safeParse({ prompt: 'x', high_detail: 'yes' }).success).toBe(false);
  });

  it('still emits a required prompt when no text-shaped field exists', () => {
    const fields: FormInputData[] = [
      field({ id: 'seed', type: 'number' }),
    ];
    const { schema, promptFieldId } = formInputsToSchema(fields);
    expect(promptFieldId).toBeNull();
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ prompt: 'x' }).success).toBe(true);
  });

  it('describes fields with bounds and default in the schema description', () => {
    const fields: FormInputData[] = [
      field({ id: 'prompt', type: 'textarea' }),
      field({ id: 'steps', type: 'number', label: 'Steps', min: 1, max: 100, default: 30, step: 1 }),
    ];
    const { schema } = formInputsToSchema(fields);
    // The optional() wrapper hides the description on the outer ZodOptional;
    // unwrap() exposes the inner schema's describe() text the LLM actually
    // consumes via the AI-SDK JSON-Schema converter.
    const stepsField = schema.shape.steps as { unwrap: () => { description?: string } };
    const stepsDesc = stepsField.unwrap().description ?? '';
    expect(stepsDesc).toContain('Steps');
    expect(stepsDesc).toContain('1-100');
    expect(stepsDesc).toContain('Default: 30');
  });
});
