---
name: wan-video
description: Configure WAN-T2V workflows for correct video generation in ComfyUI.
trigger_when: User wants to generate video with WAN, troubleshoot WAN workflow errors, or tune WAN parameters.
---

# WAN Video (WAN-T2V / WAN-I2V)

WAN (Wan2.1) is a video diffusion model available in ComfyUI through the WAN loader nodes.
It generates short video clips (up to ~5 seconds at standard resolutions) from text or image input.

## Model files

WAN requires two components:
- Main checkpoint: `wan2.1_t2v_1.3B.safetensors` or the 14B variant (higher quality, more VRAM)
- VAE: the WAN VAE file — do NOT use an SD or FLUX VAE; they are incompatible

Load with the `WanVideoModelLoader` node, not the standard CheckpointLoaderSimple.

## Resolution and frame count

Supported resolutions follow a fixed set of aspect-ratio presets. Common ones:
- 480x832 (vertical/portrait)
- 832x480 (landscape)
- 624x624 (square-ish)

Frame count must be a multiple of 4, minimum 16. Recommended range: 16-81 frames.
Higher frame counts require proportionally more VRAM and time.

## Critical workflow settings

**Sampler**: Use `euler` or `dpm++2m`. Avoid samplers that require ancestral steps unless
you know the model supports them — WAN is particularly sensitive to sampler choice.

**Steps**: 20-30 is the practical range. More than 30 rarely improves quality.

**CFG**: WAN uses a lower guidance scale than image models. Start at 4.0-6.0.
Values above 8 cause oversaturation and artifacts.

**Scheduler**: `simple` or `linear` work reliably. Avoid `karras` variants.

**Seed**: Unlike image models, WAN is highly sensitive to seed. Keep the seed fixed
when iterating on prompt changes; change it intentionally to explore variation.

## Prompt tips

WAN responds to camera motion language:
- "camera slowly zooms in on..." 
- "panning left, revealing..."
- "static shot of..."

Describe motion explicitly: "waves crashing", "leaves falling", "subject walking toward camera".
If motion is not described, WAN defaults to minimal camera/subject movement.

## Common errors

**CUDA OOM**: Reduce frame count or switch to the 1.3B model. Enable tiled VAE decoding
if the option is available in the VAE decode node.

**Black or garbled output**: Wrong VAE. Verify you are using the WAN VAE, not an SD/FLUX one.

**Temporal flickering**: Increase steps (try 25+) or reduce CFG slightly.

**Nodes not found**: Ensure the WAN custom node pack is installed via ComfyUI Manager.
