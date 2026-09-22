#!/usr/bin/env python3
"""Persistent JSONL bridge between FreeCode (TypeScript) and Laya (Python).

The process loads the checkpoint once and then serves routing requests over
stdin/stdout, one JSON object per line. There is deliberately no HTTP layer: no
port to allocate, no service discovery, no auth, and the bridge dies with its
parent.

Protocol
--------
Request  (one JSON object per line on stdin):

    {"id": "r1", "route": {"agent": "coder", "task": "...", "tools": [...]}}
    {"id": "r2", "ping": true}
    {"id": "r3", "shutdown": true}

Response (one JSON object per line on stdout):

    {"id": "r1", "ok": true, "decision": {...}}
    {"id": "r2", "ok": true, "pong": true, "loaded": false, "device": null}
    {"id": "r1", "ok": false, "error": "..."}

Diagnostics go to stderr only, so stdout stays a clean protocol channel.

Configuration (environment):
    FREECODE_LAYA_SDK        directory containing the vendored `laya` package
    FREECODE_LAYA_MODEL      checkpoint key: english | multilingual | typed-decisions
    FREECODE_LAYA_DEVICE     torch device, e.g. mps / cpu; auto-detected if unset
    FREECODE_LAYA_REPO       explicit Hugging Face repo or local checkpoint path
    FREECODE_LAYA_PRELOAD    "1" loads the checkpoint before the first request
    FREECODE_LAYA_CACHE      Hugging Face cache directory
"""

from __future__ import annotations

import json
import os
import sys
import traceback
from typing import Any, Dict, Optional

_HERE = os.path.dirname(os.path.abspath(__file__))


try:
    import sdk as _sdk
except ImportError:  # imported as part of the package
    from . import sdk as _sdk

_SDK_DIR = _sdk.install()

# Must run before `route` (and therefore `laya`) is imported, because
# huggingface_hub freezes its cache location at import time.
try:
    from cache import configure as _configure_cache
except ImportError:  # imported as part of the package
    from .cache import configure as _configure_cache

_configure_cache()

from route import Classifier  # noqa: E402 - path and cache setup must happen first


def _log(message: str) -> None:
    sys.stderr.write("[laya-bridge] %s\n" % message)
    sys.stderr.flush()


def _encode(payload: Dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


class Bridge:
    def __init__(self) -> None:
        self.classifier = Classifier(
            model=os.environ.get("FREECODE_LAYA_MODEL", "typed-decisions"),
            device=os.environ.get("FREECODE_LAYA_DEVICE") or None,
            repo=os.environ.get("FREECODE_LAYA_REPO") or None,
        )

    def handle(self, request: Dict[str, Any]) -> Dict[str, Any]:
        request_id = request.get("id")

        if request.get("shutdown"):
            return {"id": request_id, "ok": True, "shutdown": True}

        if request.get("ping"):
            return {
                "id": request_id,
                "ok": True,
                "pong": True,
                "loaded": self.classifier.loaded,
                "model": self.classifier.model,
                "load_error": self.classifier.load_error,
            }

        route_state = request.get("route")
        if not isinstance(route_state, dict):
            return {"id": request_id, "ok": False, "error": "missing 'route' object"}

        # Warmup requests exist so the first real task does not pay the model
        # load: they load the checkpoint and answer without needing state.
        if request.get("warmup"):
            loaded = self.classifier.load()
            return {
                "id": request_id,
                "ok": True,
                "warmed": loaded,
                "load_error": self.classifier.load_error,
            }

        decision = self.classifier.classify(route_state)
        return {"id": request_id, "ok": True, "decision": decision}


def main(argv: Optional[list] = None) -> int:
    argv = argv if argv is not None else sys.argv[1:]

    bridge = Bridge()

    # Resolve `--once` before serving: it is the mode used by tests and by the
    # `route-test` command, where a single request/response is the whole job.
    if "--once" in argv:
        line = sys.stdin.readline()
        if not line.strip():
            return 1
        try:
            request = json.loads(line)
        except json.JSONDecodeError as error:
            sys.stdout.write(_encode({"id": None, "ok": False, "error": "bad json: %s" % error}) + "\n")
            return 1
        try:
            response = bridge.handle(request)
        except Exception as error:  # noqa: BLE001 - reported to the caller
            traceback.print_exc(file=sys.stderr)
            response = {"id": request.get("id"), "ok": False, "error": "%s: %s" % (type(error).__name__, error)}
        sys.stdout.write(_encode(response) + "\n")
        sys.stdout.flush()
        return 0 if response.get("ok") else 1

    if os.environ.get("FREECODE_LAYA_PRELOAD") == "1":
        if bridge.classifier.load():
            _log("checkpoint %s loaded on %s" % (bridge.classifier.model, bridge.classifier.device))
        else:
            _log("checkpoint unavailable, serving rules: %s" % bridge.classifier.load_error)

    _log("ready")

    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as error:
            sys.stdout.write(_encode({"id": None, "ok": False, "error": "bad json: %s" % error}) + "\n")
            sys.stdout.flush()
            continue

        try:
            response = bridge.handle(request)
        except Exception as error:  # noqa: BLE001 - one bad request must not kill the bridge
            traceback.print_exc(file=sys.stderr)
            response = {"id": request.get("id"), "ok": False, "error": "%s: %s" % (type(error).__name__, error)}

        sys.stdout.write(_encode(response) + "\n")
        sys.stdout.flush()

        if response.get("shutdown"):
            _log("shutdown requested")
            return 0

    _log("stdin closed, exiting")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
