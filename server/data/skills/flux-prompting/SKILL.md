---
name: flux-prompting
description: Write effective FLUX image prompts for high-quality generation results.
trigger_when: User wants to write, improve, or troubleshoot a FLUX image prompt.
---

# FLUX Prompting

FLUX models (FLUX.1-dev, FLUX.1-schnell) respond best to natural-language descriptions
rather than comma-separated keyword tags. The model understands context, so write in
complete sentences and describe the scene as if explaining it to a skilled artist.

## Key principles

**Subject first**: Lead with the main subject and their key attributes before environment or style.
Good: "A red-haired woman in a leather jacket standing on a rain-soaked city street at night"
Avoid: "city, rain, night, woman, red hair, leather jacket"

**Lighting is critical**: Name the lighting type explicitly.
Examples: golden hour backlighting, overcast diffused light, neon-lit, candlelit, studio
three-point lighting, harsh midday sun, moonlit.

**Camera and lens language works**: FLUX understands photography terms.
"Shot on 85mm f/1.4, shallow depth of field, subject sharp, background bokeh"
"Cinematic wide angle, IMAX anamorphic, lens flare"

**Art direction terms**: Mentioning a style name anchors the aesthetic without needing many
modifiers. Examples: "painterly impressionist brushwork", "hyperrealistic editorial photography",
"flat vector illustration", "anime cel-shading", "ink wash painting".

**Aspect ratios and composition**: FLUX respects compositional language.
"Rule of thirds", "centered symmetrical portrait", "extreme close-up", "establishing shot",
"Dutch angle", "low angle looking up".

## What to avoid

- Avoid excessive comma lists — they dilute each concept's weight.
- Avoid contradictory instructions ("bright" + "dark moody") — pick one.
- Avoid vague quality boosters like "masterpiece, best quality, ultra HD" — these are
  Stable Diffusion 1.5 habits. FLUX does not need them and they often degrade output.
- Avoid negative prompts in positive prompt space; FLUX has a dedicated negative field.

## Refinement strategy

1. Write a one-sentence core description: subject + setting + mood.
2. Add lighting (1 phrase).
3. Add camera/lens or medium (1 phrase).
4. Add style or art direction (1 phrase).
5. Review for contradictions; cut anything redundant.

Total prompt length of 40-80 words typically outperforms both very short and very long prompts.
