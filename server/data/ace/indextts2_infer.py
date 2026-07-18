#!/usr/bin/env python3
"""Standalone IndexTTS2 voice-clone inference script.

Invoked by the Node.js TTS service via subprocess. Wraps
`indextts.infer_v2.IndexTTS2` and emits structured progress lines
(`[INDEXTTS] phase=...`) on stdout so the wrapper can parse them.

Errors are reported as a JSON object on stderr with a non-zero exit
code so the caller can surface a clean message to the user.
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
import traceback


def _emit(payload: dict) -> None:
    """Print a key=value progress line on stdout, flushed immediately."""
    parts = ["[INDEXTTS]"] + [f"{k}={v}" for k, v in payload.items()]
    print(" ".join(parts), flush=True)


def _fail(message: str, *, code: str = "indextts_error", details: str | None = None) -> None:
    err = {"error": message, "code": code}
    if details:
        err["details"] = details
    print(json.dumps(err), file=sys.stderr, flush=True)
    sys.exit(1)


def _parse_emo_vector(raw: str) -> list[float]:
    parts = [p.strip() for p in raw.split(",") if p.strip()]
    if len(parts) != 8:
        raise ValueError(f"--emo-vector requires exactly 8 comma-separated floats (got {len(parts)})")
    return [float(p) for p in parts]


def _seed_everything(seed: int) -> None:
    random.seed(seed)
    try:
        import numpy as np

        np.random.seed(seed)
    except Exception:
        pass
    try:
        import torch

        torch.manual_seed(seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(seed)
    except Exception:
        pass


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate speech using IndexTTS2 in a target voice.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--ref-audio", required=True, help="Reference voice audio file (~5-15s clean speech).")
    text_group = parser.add_mutually_exclusive_group(required=True)
    text_group.add_argument("--text", help="Text to synthesize.")
    text_group.add_argument("--text-file", help="Path to a UTF-8 file containing the text to synthesize.")
    parser.add_argument("--output", required=True, help="Path to write the generated WAV.")
    parser.add_argument("--emo-audio", default=None, help="Optional separate emotion reference audio.")
    parser.add_argument("--emo-alpha", type=float, default=1.0, help="Emotion intensity multiplier.")
    parser.add_argument("--emo-text", default=None, help="Natural-language emotion description (sets use_emo_text=True).")
    parser.add_argument("--emo-vector", default=None, help="8 comma-separated floats, sum<=1.5.")
    parser.add_argument("--fp16", action="store_true", help="Run the model in float16.")
    parser.add_argument("--device", default="cuda", help="Torch device.")
    parser.add_argument("--interval-silence", type=int, default=200, help="Milliseconds between sentences.")
    parser.add_argument("--seed", type=int, default=None, help="Optional RNG seed.")
    parser.add_argument(
        "--model-dir",
        default=os.environ.get("INDEXTTS2_MODEL_DIR"),
        help="Path to the IndexTTS-2 model dir. Falls back to HF cache (auto-snapshot_download).",
    )
    parser.add_argument(
        "--cfg-path",
        default=os.environ.get("INDEXTTS2_CFG_PATH"),
        help="Path to config.yaml. Defaults to <model-dir>/config.yaml.",
    )
    parser.add_argument(
        "--use-cuda-kernel",
        action="store_true",
        help="Enable BigVGAN compiled CUDA kernels (faster, may need build deps).",
    )
    parser.add_argument(
        "--use-deepspeed",
        action="store_true",
        help="Enable DeepSpeed acceleration (must have deepspeed extras installed).",
    )
    parser.add_argument(
        "--max-text-tokens-per-segment",
        type=int,
        default=120,
        help="Upstream IndexTTS2 segmentation chunk size.",
    )
    args = parser.parse_args()

    started = time.time()

    # Resolve text
    if args.text is not None:
        text = args.text
    else:
        try:
            with open(args.text_file, "r", encoding="utf-8") as f:
                text = f.read()
        except OSError as e:
            _fail(f"Could not read --text-file: {e}", code="text_file_read_failed")
    text = (text or "").strip()
    if not text:
        _fail("Empty text — nothing to synthesize.", code="empty_text")

    if not os.path.exists(args.ref_audio):
        _fail(f"Reference audio not found: {args.ref_audio}", code="ref_audio_missing")
    if args.emo_audio and not os.path.exists(args.emo_audio):
        _fail(f"Emotion audio not found: {args.emo_audio}", code="emo_audio_missing")

    emo_vector = None
    if args.emo_vector:
        try:
            emo_vector = _parse_emo_vector(args.emo_vector)
        except ValueError as e:
            _fail(str(e), code="bad_emo_vector")

    if args.seed is not None:
        _seed_everything(args.seed)

    _emit({"phase": "loading"})

    try:
        # IndexTTS2 lives in the upstream `indextts` package — must already be installed.
        from indextts.infer_v2 import IndexTTS2  # type: ignore
    except Exception as e:
        _fail(
            "Failed to import indextts.infer_v2.IndexTTS2 — is the `indextts` package installed?",
            code="indextts_import_failed",
            details=f"{type(e).__name__}: {e}",
        )

    # Resolve model directory.
    model_dir = args.model_dir
    if not model_dir:
        # IndexTTS2 calls snapshot_download itself if model_dir is missing — pass the HF cache marker.
        try:
            from huggingface_hub import snapshot_download  # type: ignore

            _emit({"phase": "snapshot_download", "repo": "IndexTeam/IndexTTS-2"})
            model_dir = snapshot_download(repo_id="IndexTeam/IndexTTS-2")
        except Exception as e:
            _fail(
                "No --model-dir supplied and snapshot_download failed.",
                code="model_resolve_failed",
                details=f"{type(e).__name__}: {e}",
            )

    # Resolve cfg_path — default to <model-dir>/config.yaml.
    cfg_path = args.cfg_path or os.path.join(model_dir, "config.yaml")
    if not os.path.exists(cfg_path):
        _fail(
            f"Config file not found: {cfg_path}. "
            "Make sure the IndexTTS-2 model has been downloaded.",
            code="cfg_missing",
        )

    try:
        # IndexTTS2 constructor signature (per README):
        #   IndexTTS2(cfg_path, model_dir, use_fp16, use_cuda_kernel, use_deepspeed)
        # Device is auto-detected from model placement; no explicit `device=` arg.
        tts = IndexTTS2(
            cfg_path=cfg_path,
            model_dir=model_dir,
            use_fp16=bool(args.fp16),
            use_cuda_kernel=bool(args.use_cuda_kernel),
            use_deepspeed=bool(args.use_deepspeed),
        )
    except Exception as e:
        _fail(
            f"IndexTTS2 init failed: {e}",
            code="indextts_init_failed",
            details=traceback.format_exc(limit=8),
        )

    _emit({"phase": "generating", "chars": len(text)})

    try:
        tts.infer(
            spk_audio_prompt=args.ref_audio,
            text=text,
            output_path=args.output,
            emo_audio_prompt=args.emo_audio,
            emo_alpha=float(args.emo_alpha),
            emo_vector=emo_vector,
            use_emo_text=bool(args.emo_text),
            emo_text=args.emo_text,
            interval_silence=int(args.interval_silence),
            verbose=False,
            max_text_tokens_per_segment=int(args.max_text_tokens_per_segment),
        )
    except Exception as e:
        _fail(
            f"IndexTTS2 inference failed: {e}",
            code="indextts_infer_failed",
            details=traceback.format_exc(limit=8),
        )

    if not os.path.exists(args.output):
        _fail(f"Inference completed but output file is missing: {args.output}", code="output_missing")

    duration_seconds = 0.0
    try:
        # Lightweight duration probe via wave; falls back to 0 if not parseable.
        import wave
        import contextlib

        with contextlib.closing(wave.open(args.output, "rb")) as wf:
            frames = wf.getnframes()
            rate = wf.getframerate() or 1
            duration_seconds = float(frames) / float(rate)
    except Exception:
        pass

    _emit({"phase": "done", "duration_seconds": round(duration_seconds, 3), "elapsed_ms": int((time.time() - started) * 1000)})


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:  # last-resort guard
        _fail(f"Unhandled error: {e}", code="unhandled", details=traceback.format_exc(limit=8))
