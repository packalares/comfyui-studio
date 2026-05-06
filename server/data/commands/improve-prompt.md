---
name: improve-prompt
description: Rewrite an image prompt to be vivid and FLUX-friendly.
argument_hint: <prompt>
---

Rewrite the following image prompt to be more vivid, specific, and effective for FLUX image generation.

Rules:
- Use natural-language sentences, not comma-separated keyword lists.
- Lead with the subject, then setting, then lighting, then camera/style.
- Keep the core intent of the original prompt intact.
- Remove generic quality boosters like "masterpiece" or "best quality".
- Total length should be 40-80 words.
- Return only the improved prompt text, no explanation.

Original prompt:
$ARGUMENTS
