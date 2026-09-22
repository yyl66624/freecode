"""Typed question schema and state rendering for FreeCode's Laya routing.

The bridge asks Laya one fixed set of questions per task. Question ids match
FreeCode's `RouteDecision` fields exactly, so the Python side and the TypeScript
`freecode/router/types.ts` stay in lockstep.

Two budgets shape everything here:

* Laya renders the question head (instructions plus every option label) into a
  fixed `head_max_len` (256 tokens in the `typed-decisions` bundle), so option
  labels must stay short.
* The whole sequence is capped by the checkpoint's `max_len` (1024 for that
  same bundle), so the rendered state must stay small. `render_state` therefore
  emits compact `key: value` lines and drops the least important fields first
  rather than truncating mid-sentence.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

# Minimum model capability required, ordered weakest to strongest. The order is
# load-bearing: the scheduler treats a higher index as "strictly more capable".
TIERS: List[str] = ["local", "fast", "standard", "strong", "max"]

# Software-engineering task classes.
KINDS: List[str] = ["inspect", "coding", "debug", "test", "research", "review", "docs", "git"]

# Task classes that only read the repository. These are the only ones FreeCode
# is willing to run concurrently in v0.1, because OpenCode's permission system
# is not a sandbox.
READ_ONLY_KINDS = {"inspect", "research", "review", "git"}

# Task classes whose result must be independently checked before it is trusted.
REVIEW_REQUIRED_KINDS = {"coding", "debug", "test", "docs"}


def questions() -> Dict[str, Dict[str, Any]]:
    """The fixed question set. Never vary these ids across requests."""
    return {
        "kind": {
            "type": "choice",
            "instructions": "Classify the software-engineering task.",
            "criteria": {
                "inspect": "read or explore existing code",
                "coding": "change or add production code",
                "debug": "diagnose a failure or wrong behaviour",
                "test": "write or run tests and fixtures",
                "research": "gather outside information or docs",
                "review": "judge code that already exists",
                "docs": "write prose, comments or documentation",
                "git": "version control operations",
            },
        },
        "tier": {
            "type": "choice",
            "instructions": "Choose the minimum model capability required.",
            "criteria": {
                "local": "no reasoning needed, pure lookup",
                "fast": "simple, mechanical change",
                "standard": "ordinary engineering work",
                "strong": "subtle logic, architecture, hard bug",
                "max": "frontier reasoning is essential",
            },
        },
        "difficulty": {
            "type": "score",
            "instructions": "Estimate task difficulty.",
            "criteria": ["trivial", "easy", "normal", "hard", "expert"],
        },
        "needs_review": {
            "type": "noul",
            "instructions": "Should another model independently review the result?",
        },
        "parallelizable": {
            "type": "noul",
            "instructions": "Can this task run independently of other work in flight?",
        },
    }


_ORDERED_FIELDS = ("agent", "task", "tools", "files", "prior_failures", "constraints")


def render_state(state: Dict[str, Any]) -> str:
    """Render a FreeCode routing state into a compact block for Laya.

    Unknown keys are ignored: the model was not trained on them, and dropping
    them keeps the state inside the checkpoint's context window.
    """
    lines: List[str] = []
    for field in _ORDERED_FIELDS:
        value = state.get(field)
        if value is None or value == "" or value == []:
            continue
        if isinstance(value, (list, tuple, set)):
            rendered = ", ".join(str(item) for item in value)
        else:
            rendered = str(value)
        lines.append("%s: %s" % (field, _collapse(rendered)))
    return "\n".join(lines)


def _collapse(text: str) -> str:
    return " ".join(text.split())


def clamp_state(state: Dict[str, Any], limit: int) -> Dict[str, Any]:
    """Trim the free-text task description until the rendered state fits.

    `limit` is a character budget approximating the token budget: English
    software-engineering text runs close to four characters per token, and the
    tokenizer is the authority only after the fact. Trimming here means the
    state is short enough to survive the checkpoint's own truncation intact.
    """
    rendered = render_state(state)
    if len(rendered) <= limit:
        return state
    trimmed = dict(state)
    task = _collapse(str(trimmed.get("task", "")))
    overhead = len(rendered) - len(task)
    budget = max(0, limit - overhead)
    trimmed["task"] = task[:budget].rstrip()
    return trimmed

def domain_question() -> Dict[str, Dict[str, Any]]:
    """Laya's own `domain` preset, used verbatim.

    This is the only question in the routing pass whose confidence is
    calibrated, because the checkpoint was trained on exactly this id, wording
    and option set. Its answer is coarse — it does not distinguish debugging from
    testing — but it is the one signal that can contradict a route: work the
    model confidently places outside software engineering should not be sent
    through the coding pipeline.

    The wording is copied from the SDK's shipped `router_questions()` preset, and
    must stay that way. Rewording it is what destroys the calibration.
    """
    return {
        "domain": {
            "type": "choice",
            "instructions": "What domain does `request` belong to?",
            "criteria": {
                "code": "software engineering, programming, refactoring, architecture, debugging",
                "math_or_logic": "mathematics, logic puzzles, proofs, complex calculation",
                "writing": "creative writing, essays, emails, blog posts, copywriting",
                "factual_lookup": "facts, definitions, trivia, history",
                "data_analysis": "statistics, SQL, data manipulation, metrics",
                "chitchat": "casual conversation, greetings, small talk",
            },
        }
    }


def difficulty_question() -> Dict[str, Dict[str, Any]]:
    """Laya's own `difficulty` preset, used verbatim.

    Calibrated in the sense that matters for routing: its score separates the
    benchmark's easy band (mean required tier 1.38) from its hard band (2.62),
    monotone but with overlap. Its *confidence* is not usable — 0.06-0.14 — so
    the score is treated as a ranking signal with a threshold, never as a
    calibrated probability.

    Measured over 27 labelled tasks: correlation with required tier r=0.589,
    score range 1.41-2.10.

    The wording is copied from the SDK's shipped `router_questions()` preset and
    must stay that way; rewording is what destroys calibration.
    """
    return {
        "difficulty": {
            "type": "score",
            "instructions": "How hard is `request` for a language model?",
            "criteria": [
                "trivial: a lookup or one-liner",
                "easy: short answer, no reasoning",
                "moderate: several steps",
                "hard: long multi-step reasoning or specialist knowledge",
            ],
        }
    }
