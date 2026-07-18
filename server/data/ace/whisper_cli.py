#!/usr/bin/env python3
"""Batch-transcribe a directory of audio files with faster-whisper.

For each audio file in the input directory, writes:
  <basename>.txt       — the transcribed lyrics text
  <basename>.lang.txt  — the detected ISO 639-1 language code

These companion files are recognized by ACE-Step's `build-dataset`
endpoint — when present, samples get `raw_lyrics` populated automatically,
and `label_sample()` uses the `has_preloaded_lyrics` path instead of
asking the 5Hz LM to re-transcribe (which it does poorly for any non-EN/ZH
language). The LM still does caption / genre / BPM detection per sample,
just not lyrics.

Designed to run AFTER stem extraction completes, while the GPU is still
empty (ACE-Step's DiT + 5Hz LM lazy-load only when the user enters Step 2
"Label" in the training panel). Whisper-large-v3 fp16 takes ~3 GB on GPU
and runs at ~5-10s per 5-min song. Model is unloaded explicitly at end of
batch so the user's subsequent Label step has full GPU available for
ACE-Step models.

Run:
  python3 whisper_cli.py /path/to/stems_dir
  python3 whisper_cli.py /path/to/stems_dir --device cpu --compute-type int8
"""
from __future__ import annotations

import argparse
import gc
import os
import sys
import time
from pathlib import Path

AUDIO_EXTS = {".wav", ".mp3", ".flac", ".ogg", ".opus", ".m4a"}

# Filter out Whisper hallucinations on noisy / silent / extremely short audio.
# Below this many characters the transcript is more noise than signal.
MIN_LYRICS_LEN = 20


def parse_args():
    ap = argparse.ArgumentParser(description="Batch transcribe audio files with faster-whisper")
    ap.add_argument("input_dir", help="directory containing audio files (.wav/.mp3/.flac/...)")
    ap.add_argument(
        "--model-dir",
        default=os.environ.get("WHISPER_MODEL_DIR", "/app/.whisper-models/large-v3"),
        help="path to faster-whisper model directory",
    )
    ap.add_argument("--device", default=os.environ.get("WHISPER_DEVICE", "cuda"),
                    help="cuda or cpu")
    ap.add_argument("--compute-type", default=os.environ.get("WHISPER_COMPUTE_TYPE", "float16"),
                    help="float16 (cuda), int8 (cpu), int8_float16, etc.")
    ap.add_argument("--beam-size", type=int, default=5)
    ap.add_argument("--no-vad", action="store_true",
                    help="disable VAD filter (default: VAD enabled, skips silent regions)")
    ap.add_argument("--overwrite", action="store_true",
                    help="re-transcribe files that already have .txt+.lang.txt companions")
    return ap.parse_args()


def main() -> int:
    args = parse_args()

    input_dir = Path(args.input_dir)
    if not input_dir.is_dir():
        print(f"ERROR: not a directory: {input_dir}", file=sys.stderr)
        return 2

    files = sorted(
        f for f in input_dir.iterdir()
        if f.is_file() and f.suffix.lower() in AUDIO_EXTS
    )
    if not files:
        print(f"no audio files found in {input_dir}")
        return 0

    print(f"[whisper_cli] {len(files)} files in {input_dir}")
    print(f"[whisper_cli] device={args.device} compute_type={args.compute_type}")
    print(f"[whisper_cli] model={args.model_dir}")

    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        print(f"ERROR: faster-whisper not installed: {exc}", file=sys.stderr)
        return 3

    t_load = time.time()
    model = WhisperModel(args.model_dir, device=args.device, compute_type=args.compute_type)
    print(f"[whisper_cli] loaded in {time.time() - t_load:.1f}s")

    # Heuristic for "Whisper bailed early": elapsed < 5s on a multi-minute song
    # almost always means VAD cut everything as silence (rap intros, skits,
    # dropouts at the start). For these we retry pass 2 without VAD.
    SUSPICIOUS_ELAPSED_SECS = 5.0

    def transcribe_one(f, vad_filter=True):
        segments, info = model.transcribe(
            str(f),
            beam_size=args.beam_size,
            vad_filter=vad_filter,
        )
        text = " ".join(seg.text.strip() for seg in segments).strip()
        lang = info.language or "unknown"
        return text, lang

    success = 0
    skipped = 0
    failed = 0
    pending_retry: list[tuple[Path, Path, Path, str, int]] = []
    # Each pending entry: (f, txt_path, lang_path, pass1_lang, pass1_chars)
    try:
        # === PASS 1 — VAD enabled (default), auto language detect ===
        for i, f in enumerate(files, 1):
            # Build companion paths by string concat, NOT pathlib's
            # with_suffix() — for filenames like `track.info_.mp3`, with_suffix
            # treats `.info_` as the suffix and would strip it, producing
            # `track.txt` (without the `.info_`) which build-dataset then can't
            # find. f-string from the bare stem path keeps every dot intact.
            base = f.with_suffix("")  # Path(".../track.info_")
            txt_path = Path(f"{base}.txt")
            lang_path = Path(f"{base}.lang.txt")

            if not args.overwrite and txt_path.exists() and lang_path.exists():
                print(f"  [{i}/{len(files)}] {f.name}: already transcribed, skipping")
                skipped += 1
                continue

            t0 = time.time()
            try:
                text, lang = transcribe_one(f, vad_filter=not args.no_vad)
            except Exception as exc:
                print(f"  [{i}/{len(files)}] {f.name}: FAILED ({exc})", file=sys.stderr)
                failed += 1
                continue

            elapsed = time.time() - t0

            # Retry trigger 1: nothing usable came back at all.
            if len(text) < MIN_LYRICS_LEN:
                print(
                    f"  [{i}/{len(files)}] {f.name}: pass1 too short "
                    f"({len(text)} chars, lang={lang}, {elapsed:.1f}s) — queueing for retry"
                )
                pending_retry.append((f, txt_path, lang_path, lang, len(text)))
                continue

            # Retry trigger 2: VAD bailed early (elapsed << song duration).
            # Songs are typically 2-5 min; VAD-enabled transcription of a
            # full song usually takes ≥5s. Anything completed in <5s likely
            # got truncated to the first 30s or so — retry without VAD to
            # capture the whole song.
            if elapsed < SUSPICIOUS_ELAPSED_SECS:
                print(
                    f"  [{i}/{len(files)}] {f.name}: pass1 suspiciously fast "
                    f"({len(text)} chars, lang={lang}, {elapsed:.1f}s — likely VAD-truncated) — queueing for retry"
                )
                pending_retry.append((f, txt_path, lang_path, lang, len(text)))
                continue

            txt_path.write_text(text, encoding="utf-8")
            lang_path.write_text(lang, encoding="utf-8")
            print(
                f"  [{i}/{len(files)}] {f.name}: lang={lang} chars={len(text)} "
                f"in {elapsed:.1f}s"
            )
            success += 1

        # === PASS 2 — retry queued files with VAD disabled ===
        # Same auto language detection (no language hint forced — multilingual
        # artists handled correctly per user constraint). The only difference
        # vs pass 1 is vad_filter=False so Whisper sees the whole audio.
        if pending_retry:
            print(f"[whisper_cli] pass2: retrying {len(pending_retry)} file(s) with VAD disabled")
            for f, txt_path, lang_path, _, p1_len in pending_retry:
                t0 = time.time()
                try:
                    text, lang = transcribe_one(f, vad_filter=False)
                except Exception as exc:
                    print(f"  retry {f.name}: FAILED ({exc})", file=sys.stderr)
                    skipped += 1
                    continue
                elapsed = time.time() - t0
                # Accept the retry only if it produced meaningfully more than
                # pass 1. Otherwise the file is genuinely instrumental / no vocals.
                if len(text) < MIN_LYRICS_LEN:
                    print(f"  retry {f.name}: still too short ({len(text)} chars, {elapsed:.1f}s) — instrumental")
                    skipped += 1
                    continue
                txt_path.write_text(text, encoding="utf-8")
                lang_path.write_text(lang, encoding="utf-8")
                print(f"  retry {f.name}: lang={lang} chars={len(text)} (no-VAD, was {p1_len}) in {elapsed:.1f}s")
                success += 1
    finally:
        # Always release the model and reclaim VRAM/RAM, even on error.
        del model
        gc.collect()
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass
        print("[whisper_cli] model unloaded, accelerator caches cleared")

    print(f"[whisper_cli] done: {success} transcribed, {skipped} skipped, {failed} failed")
    return 0 if failed == 0 else 4


if __name__ == "__main__":
    sys.exit(main())
