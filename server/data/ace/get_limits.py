#!/usr/bin/env python3
"""GPU-tier probe: reports max generation duration/batch size for this card.

Ported from ace-step-ui's `server/scripts/get_limits.py`. The original
inserted `ACESTEP_PATH` onto `sys.path` because ace-step-ui ran against a
checked-out ACE-Step-1.5 source tree; here `ace-step` is installed as a
regular pip package (see `services/packs/registry.ts`), so a plain import
is enough — no sys.path surgery needed.
"""
import json

from acestep.gpu_config import get_gpu_config


def main() -> None:
    cfg = get_gpu_config()
    print(json.dumps({
        "tier": cfg.tier,
        "gpu_memory_gb": cfg.gpu_memory_gb,
        "max_duration_with_lm": cfg.max_duration_with_lm,
        "max_duration_without_lm": cfg.max_duration_without_lm,
        "max_batch_size_with_lm": cfg.max_batch_size_with_lm,
        "max_batch_size_without_lm": cfg.max_batch_size_without_lm,
    }))


if __name__ == "__main__":
    main()
