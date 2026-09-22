"""Workspace-local Hugging Face cache, configured before any HF import.

`huggingface_hub` resolves its cache directory from the environment the moment
it is imported, and `transformers` imports it transitively. Setting `HF_HOME`
after importing `laya` is therefore too late, and a checkpoint download lands in
`~/.cache/huggingface` regardless.

`configure()` must be called before the first `laya` import. Every entry point in
this package does so at the top of the file.
"""

from __future__ import annotations

import os
from typing import Optional


def configure(cache: Optional[str] = None) -> Optional[str]:
    """Point the HF cache at `cache` (or `FREECODE_LAYA_CACHE`). Returns the path."""
    target = cache or os.environ.get("FREECODE_LAYA_CACHE")
    if not target:
        return None

    os.makedirs(target, exist_ok=True)
    # Both names matter: older huggingface_hub releases read HF_HOME and derive
    # the hub directory from it, newer ones prefer HF_HUB_CACHE when present.
    os.environ["HF_HOME"] = target
    os.environ["HF_HUB_CACHE"] = os.path.join(target, "hub")
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    os.makedirs(os.environ["HF_HUB_CACHE"], exist_ok=True)
    return target
