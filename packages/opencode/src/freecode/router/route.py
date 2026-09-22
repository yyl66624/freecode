"""Turn a Laya answer set into FreeCode's `RouteDecision`.

The classifier never names a concrete model or account. It answers only what
capability the task needs; picking a real resource is the scheduler's job.

Every path through this module produces a usable decision. If the checkpoint is
missing, fails to load, or returns something off-schema, `classify` falls back
to deterministic rules and reports `source: "rules"` so the caller can see that
it happened instead of silently trusting a degraded route.
"""

from __future__ import annotations

import re
from typing import Any, Dict, Optional, Tuple

try:
    from .questions import (
        KINDS,
        READ_ONLY_KINDS,
        REVIEW_REQUIRED_KINDS,
        TIERS,
        clamp_state,
        questions,
        render_state,
    )
except ImportError:  # loaded as a top-level module by the bridge subprocess
    from questions import (  # type: ignore[no-redef]
        KINDS,
        READ_ONLY_KINDS,
        REVIEW_REQUIRED_KINDS,
        TIERS,
        clamp_state,
        questions,
        render_state,
    )

# Character budget approximating the checkpoint's token budget. The
# `typed-decisions` bundle ships `max_len: 1024` with a 256-token question head,
# leaving roughly 750 tokens of state; software-engineering English runs close
# to four characters per token, so ~2800 characters stays inside the window.
# The real tokenizer is the authority, so this is a conservative pre-trim that
# keeps truncation from landing mid-sentence.
STATE_CHAR_BUDGET = 2600

# The difficulty question renders five levels, so its expected index spans
# 0..4 and maps onto FreeCode's 1..5 scale.
DIFFICULTY_LEVELS = 5

# Score answers are an expected option index; `_score` shifts them onto 1..n.
_DIFFICULTY_DEFAULT = 3.0

# Below this minimum confidence the model is treated as uninformative about the
# task class, and the route keeps the rules baseline with a raised tier. Chosen
# from measurement, not taste: the checkpoint scores 0.38-0.79 on its own
# trained presets and 0.02-0.29 on FreeCode's question set, so this threshold
# separates "Laya knows this shape of question" from "Laya is guessing".
LOW_CONFIDENCE = 0.30

# Highest tier an out-of-distribution escalation may reach on its own.
MAX_ESCALATION_TIER = "strong"


class Classifier:
    """Owns the Laya agent and converts its answers into route decisions."""

    def __init__(self, model: str = "typed-decisions", device: Optional[str] = None, repo: Optional[str] = None):
        self.model = model
        self.device = device
        self.repo = repo
        self._agent = None
        self._load_error: Optional[str] = None

    @property
    def loaded(self) -> bool:
        return self._agent is not None

    @property
    def load_error(self) -> Optional[str]:
        return self._load_error

    def load(self) -> bool:
        """Load the checkpoint once. Returns False instead of raising.

        A missing model is an expected state on a fresh install, not a crash:
        FreeCode stays usable on rules until the model is available.
        """
        if self._agent is not None:
            return True
        try:
            from laya import load
        except ImportError as error:
            self._load_error = "laya package not importable: %s" % error
            return False

        try:
            if self.repo:
                self._agent = load(self.repo, device=self.device)
            else:
                name = self.model
                subfolder = None if name == "english" else name
                self._agent = load("convaiinnovations/laya", device=self.device, subfolder=subfolder)
        except Exception as error:  # noqa: BLE001 - surfaced through load_error
            self._load_error = "%s: %s" % (type(error).__name__, error)
            self._agent = None
            return False

        if self.device:
            self._agent.device = self._agent.device
        return True

    def classify(self, state: Dict[str, Any]) -> Dict[str, Any]:
        prepared = clamp_state(state, STATE_CHAR_BUDGET)
        rendered = render_state(prepared)
        baseline = fallback_decision(state, reason="rules baseline")
        if not self.load():
            return baseline

        try:
            result = self._agent.predict(rendered, questions())
            answers = result["answers"]
        except Exception as error:  # noqa: BLE001 - any inference failure degrades to rules
            return fallback_decision(state, reason="%s: %s" % (type(error).__name__, error))

        return decision_from_answers(answers, baseline)


def decision_from_answers(answers: Dict[str, Any], baseline: Dict[str, Any]) -> Dict[str, Any]:
    """Combine Laya's calibrated answers with the deterministic rules baseline.

    Neither signal is trusted alone. Measured against the shipped
    `typed-decisions` checkpoint, Laya is well calibrated on its own trained
    presets (confidence 0.4-0.8) but out of distribution on FreeCode's question
    set (0.02-0.29), so its answers are evidence weighted by confidence rather
    than verdicts. The rules never go out of distribution, but they cannot read
    nuance. Where the two agree the answer is confident; where they disagree the
    rules win and the tier is raised, because under-provisioning a model costs a
    failed turn while over-provisioning only costs tokens.
    """
    confidence = _min_confidence(answers)
    kind_answer = _choice(answers, "kind", KINDS, "")
    tier_answer = _choice(answers, "tier", TIERS, "")

    agree = bool(kind_answer) and kind_answer == baseline["kind"]
    kind = kind_answer if agree else baseline["kind"]

    # Laya's tier is only promoted above the baseline, never used to go cheaper:
    # a low-confidence "fast" on a task the rules read as `strong` is not a
    # reason to downgrade.
    tier = _max_tier(baseline["tier"], tier_answer) if agree else baseline["tier"]

    # Escalate at most one step, and only for a reason that applies. Disagreement
    # and low confidence usually coincide — they are two symptoms of the same
    # out-of-distribution input — so applying both would march every unfamiliar
    # task to `max` and defeat the scheduler.
    #
    # The ceiling is `strong`, not `max`: an OOD task class is a reason to spend
    # more than the rules alone would, but reserving `max` for work the rules
    # read as genuinely frontier keeps the strongest resources available.
    if (not agree or confidence < LOW_CONFIDENCE) and tier != MAX_ESCALATION_TIER:
        tier = _bump(tier)

    difficulty = _score(answers, "difficulty", default=baseline["difficulty"], levels=DIFFICULTY_LEVELS)

    # The model is asked whether a review is needed, but its answer is combined
    # with a floor: anything that changed code must be reviewed regardless of
    # what the model thinks, because an unreviewed write is the expensive kind
    # of mistake.
    model_review = _noul(answers, "needs_review", default=False)
    needs_review = model_review or kind in REVIEW_REQUIRED_KINDS

    # Parallelism is the opposite: the model can only veto it. FreeCode will not
    # run a write in parallel just because the model felt optimistic.
    model_parallel = _noul(answers, "parallelizable", default=False)
    parallelizable = model_parallel and kind in READ_ONLY_KINDS

    return {
        "kind": kind,
        "tier": tier,
        "difficulty": difficulty,
        "needsReview": needs_review,
        "parallelizable": parallelizable,
        "confidence": confidence,
        "source": "laya",
        "reason": "rules=%s/%s laya=%s/%s agree=%s confidence=%.3f"
        % (baseline["kind"], baseline["tier"], kind_answer or "-", tier_answer or "-", agree, confidence),
    }


def _choice(answers: Dict[str, Any], qid: str, allowed: list, default: str) -> str:
    answer = answers.get(qid) or {}
    value = answer.get("choice")
    if isinstance(value, str) and value in allowed:
        return value
    return default


def _max_tier(left: str, right: str) -> str:
    if not right:
        return left
    return left if TIERS.index(left) >= TIERS.index(right) else right


def _noul(answers: Dict[str, Any], qid: str, default: bool) -> bool:
    answer = answers.get(qid) or {}
    value = answer.get("noul")
    if isinstance(value, (int, float)):
        return bool(value >= 0.5)
    return default


def _score(answers: Dict[str, Any], qid: str, default: float, levels: int) -> float:
    answer = answers.get(qid) or {}
    value = answer.get("score")
    if not isinstance(value, (int, float)):
        return default
    # `score` is the probability-weighted mean option index, so it lands in
    # [0, levels-1] and shifts to FreeCode's 1..levels difficulty scale. Scaling
    # it any further saturates the result and destroys the distinction between
    # "normal" and "expert", which is the whole point of measuring it.
    return round(min(float(levels), max(1.0, float(value) + 1)), 2)


def _min_confidence(answers: Dict[str, Any]) -> float:
    values = [a.get("confidence") for a in answers.values() if isinstance(a, dict)]
    numeric = [float(v) for v in values if isinstance(v, (int, float))]
    if not numeric:
        return 0.0
    # Report the weakest link: a route is only as trustworthy as its shakiest
    # dimension, and callers threshold on this to decide whether to re-ask.
    #
    # Note this is per-question calibration, not accuracy. An unfamiliar task
    # class legitimately yields a near-zero minimum even when the choice is
    # right, so a low value argues for a stronger tier rather than for
    # discarding the route. Only `source: "rules"` means Laya did not answer.
    return round(min(numeric), 4)


_RULE_PATTERNS: Tuple[Tuple[str, str], ...] = (
    # Review language is checked first because it describes the *intent* of the
    # task, while every other pattern describes whatever the task happens to
    # mention. "Review this patch for regressions" is a review, not a debug
    # task, even though "regressions" matches the debug pattern.
    ("review", r"\b(review|audit|critique|second opinion|sanity ?check|inspect the (patch|change)s?)\w*"),
    ("debug", r"\b(fail|failing|failure|broken|crash|error|bug|regress|stack ?trace|traceback|debug)\w*"),
    ("test", r"\b(test|tests|pytest|jest|vitest|spec|coverage|fixture)\w*"),
    ("git", r"\b(git|commit|rebase|merge|branch|cherry ?pick|stash)\b"),
    ("docs", r"\b(doc|docs|documentation|readme|changelog|comment)\w*"),
    ("research", r"\b(research|find out|look up|compare|investigate|explore|survey)\w*"),
    ("inspect", r"\b(read|inspect|list|show|explain|where|which|find|locate|summar)\w*"),
)

_TIER_BY_KIND = {
    "inspect": "fast",
    "research": "fast",
    "git": "fast",
    "docs": "standard",
    "test": "standard",
    "review": "strong",
    "coding": "standard",
    "debug": "strong",
}


def fallback_decision(state: Dict[str, Any], reason: Optional[str] = None) -> Dict[str, Any]:
    """Deterministic rules used when Laya is unavailable or unreliable."""
    text = " ".join(
        str(state.get(field, "")) for field in ("task", "agent", "constraints")
    ).lower()
    kind = "coding"
    for candidate, pattern in _RULE_PATTERNS:
        if re.search(pattern, text):
            kind = candidate
            break

    tier = _TIER_BY_KIND.get(kind, "standard")
    # An explicit request for harder reasoning, or a task that already failed
    # attempts, raises the floor: those are the two signals that reliably mean
    # a cheaper model will waste a turn.
    failures = state.get("prior_failures")
    if isinstance(failures, int) and failures > 0:
        tier = _bump(tier)
    if re.search(r"\b(deep|careful|thorough|architecture|design|complex|subtle)\w*", text):
        tier = _bump(tier)
    if re.search(r"\b(trivial|typo|rename|one ?line|simple)\w*", text) and tier == "standard":
        tier = "fast"

    return {
        "kind": kind,
        "tier": tier,
        "difficulty": {"local": 1.0, "fast": 2.0, "standard": 3.0, "strong": 4.0, "max": 5.0}[tier],
        "needsReview": kind in REVIEW_REQUIRED_KINDS,
        "parallelizable": kind in READ_ONLY_KINDS,
        "confidence": 0.0,
        "source": "rules",
        "reason": reason or "rules fallback",
    }


def _bump(tier: str) -> str:
    index = TIERS.index(tier) if tier in TIERS else TIERS.index("standard")
    return TIERS[min(len(TIERS) - 1, index + 1)]
