"""Locate the vendored Laya SDK and its checkpoint cache.

Both the bridge (`main.py`) and the benchmark (`benchmark.py`) need this, and
both must apply it before importing `laya`: `huggingface_hub` freezes its cache
location at import time, so a later `HF_HOME` change has no effect and the
checkpoint download escapes to `~/.cache/huggingface`.

Order matters:

    import sdk; sdk.install()      # sys.path, no third-party imports
    import cache; cache.configure()  # environment, before `import laya`
    from route import ...          # pulls in `laya` and therefore huggingface_hub
"""

from __future__ import annotations

import os
import sys
from typing import Optional


def install(explicit: Optional[str] = None) -> Optional[str]:
    """Put the vendored Laya package on `sys.path`, if it is not already there.

    The SDK is not imported from site-packages because FreeCode must run the Laya
    revision that ships with the repository. The directory is found by walking up
    from this file, which keeps it working regardless of how deep the workspace
    nests the fork. Returns the directory used, or `None` when none was found.
    """
    from_env = explicit or os.environ.get("FREECODE_LAYA_SDK")
    if from_env:
        return from_env if _add(from_env) else None

    candidate = os.path.dirname(os.path.abspath(__file__))
    for _ in range(10):
        candidate = os.path.dirname(candidate)
        if not candidate or candidate == os.sep:
            break
        found = os.path.join(candidate, "laya-main")
        if os.path.isdir(os.path.join(found, "laya")):
            _add(found)
            return found
    return None


def _add(directory: str) -> bool:
    if not os.path.isdir(os.path.join(directory, "laya")):
        return False
    if directory not in sys.path:
        sys.path.insert(0, directory)
    return True
