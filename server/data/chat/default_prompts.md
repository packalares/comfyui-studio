# Default prompts and chat suggestions
#
# Server reads this on boot via `services/chat/promptsLoader.ts`.
# Sections start with `## ` and the body runs until the next `## ` heading.
# Mustache-style {{placeholders}} get substituted at call time.
# `## suggestions/...` sections are sent to the UI via /api/system → chat.suggestions.
#
# Override by creating ~/.config/comfyui-studio/chat/default_prompts.md;
# the user file wins over this bundled default whenever it exists.

## title
Summarize this conversation in 4-6 words as a title. Reply with ONLY the title, no quotes, no punctuation. The conversation: {{userText}} {{assistantText}}

## compact-summary-prefix
Summarize the following conversation in approximately 200 words. Preserve the key topics, decisions, and any pending questions. Reply with ONLY the summary, no preamble. The conversation:

## compact-summary-wrap
Conversation summary so far: {{summary}}

## tool-description.web-search
Search the public web via a SearXNG metasearch engine. Returns a numbered list of titles, URLs, and snippets — use the URLs as citations when answering the user.

## tool-description.generate-image
Generate an image from a text prompt. Call this whenever the user asks for a picture, image, photo, illustration, render, painting, drawing, or any visual. Pass the user's request as `prompt`; optionally set width / height / steps / seed / cfg / sampler / negative_prompt when the user specifies (e.g. "4K" → width=3840, height=2160). The image appears in chat when ready.

## tool-label.web-search
Web search

## tool-label-description.web-search
Search the public web via SearXNG and cite results.

## tool-label.generate-image
Generate image

## tool-label-description.generate-image
Generate an image via a ComfyUI template workflow.

## generate-image.queued-result
Image generation queued.
template: {{templateName}}
prompt_id: {{promptId}}{{fieldNote}}
The rendered image will appear inline in this chat as soon as ComfyUI finishes — no navigation needed. Reply with one short sentence acknowledging the request. Do NOT instruct the user to open the gallery, do NOT describe the image, do NOT mention DALL-E / Midjourney / "uploading" / "self-image".

## generate-image.prompt-field-note
 (prompt routed to field "{{fieldId}}")

## generate-image.no-field-note
 (no prompt-shaped field; template defaults applied)

## generate-image.failed-prefix
generate_image failed: 

## generate-image.no-template-error
generate_image failed: no template selected and no default image template is configured. Ask the user to set a default in Settings → Tools, or pass an explicit `template` argument.

## tool-error-reprompt
tool error: {{errorMessage}}

## suggestions.empty-state
- Generate an image of a cyberpunk city at night
- Search the web for the latest local LLM benchmarks
- Explain this code
- Brainstorm names for a new project
- Summarize a topic for me

## suggestions.contextual.code-fenced
- Explain this code
- Write a unit test for it

## suggestions.contextual.question
- Yes, please
- No thanks
- Tell me more

## suggestions.contextual.url-bearing
- Summarize the linked sources

## suggestions.contextual.fallback
- Tell me more
- Give me an example

## suggestions.contextual.long-reply-extra
Summarize this
