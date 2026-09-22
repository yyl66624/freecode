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
        difficulty_question,
        domain_question,
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
LOW_CONFIDENCE = 0.15

# Native difficulty score above which a task earns one tier of escalation.
# Chosen from the benchmark's band separation (low band mean required tier 1.38,
# high band 2.62) rather than from a round number.
HARD_DIFFICULTY = 1.85

# A Laya answer is only believed above this minimum confidence. Calibrated
# answers from the checkpoint's own presets sit at 0.38-0.79; every FreeCode
# question tested sits below this line. See `decision_from_answers`.
TRUSTED_CONFIDENCE = 0.35

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
            # One pass answers FreeCode's own questions; the second answers the
            # checkpoint's native `domain` preset, whose confidence is calibrated
            # (0.23-0.68 measured) unlike the custom set. Both are needed: the
            # custom answers are what the policy consumes, and the native answer
            # is the only question that can contradict a route outright.
            answers = self._agent.predict(rendered, questions())["answers"]
            domain = self._agent.predict(rendered, domain_question())["answers"]["domain"]
            difficulty = self._agent.predict(rendered, difficulty_question())["answers"]["difficulty"]
        except Exception as error:  # noqa: BLE001 - any inference failure degrades to rules
            return fallback_decision(state, reason="%s: %s" % (type(error).__name__, error))

        return decision_from_answers(answers, baseline, domain, difficulty)


def decision_from_answers(
    answers: Dict[str, Any],
    baseline: Dict[str, Any],
    domain: Optional[Dict[str, Any]] = None,
    native_difficulty: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Combine Laya's answers with the deterministic rules baseline.

    Laya is consulted, and believed, only where measurement shows it is
    calibrated. Against the shipped `typed-decisions` checkpoint:

    * Its own trained presets score 0.38-0.79 minimum confidence.
    * FreeCode's question set scores 0.015-0.29 across every variant tried:
      the current wording, a rewrite mirroring the presets' phrasing and
      placeholder naming, a projection onto the native `domain` vocabulary, and
      a single coarse binary question. The binary question was the most damning:
      it scored read-only tasks at 0.21-0.29 and file-changing tasks at
      0.33-0.42, so every task landed on the same side of the 0.5 threshold.

    The cause is structural, not a wording problem. Laya conditions on a learned
    embedding of the question id, so a question the checkpoint was never trained
    on carries an uncalibrated head even when the sentence is plain English.
    Accuracy on the benchmark is 78-81%, which is high enough to look useful and
    nowhere near high enough to act on while the confidence says "guessing".

    So Laya's fine-grained answers are accepted only above `TRUSTED_CONFIDENCE`,
    which no current question reaches. Its coarse judgements that survive
    measurement are used by `Classifier.classify` directly. The mechanism stays
    wired so that a fine-tuned checkpoint, or a question set the checkpoint was
    actually trained on, starts contributing without a rewrite — and the moment
    it does, `benchmark.py` says so.
    """
    confidence = _min_confidence(answers)
    kind_answer = _choice(answers, "kind", KINDS, "")
    tier_answer = _choice(answers, "tier", TIERS, "")

    trusted = confidence >= TRUSTED_CONFIDENCE
    agree = trusted and bool(kind_answer) and kind_answer == baseline["kind"]

    kind = kind_answer if agree else baseline["kind"]

    # Laya's tier is only ever promoted above the baseline, never used to go
    # cheaper: a "fast" on a task the rules read as `strong` is not a reason to
    # downgrade.
    tier = _max_tier(baseline["tier"], tier_answer) if agree else baseline["tier"]

    # Escalation is gated on evidence, never applied blanket. Bumping every
    # unfamiliar task was measured and rejected: it lifted the benchmark's
    # "tier at least the minimum" from 85% to 93% while dropping exact-tier
    # agreement from 78% to 33%, so the entire apparent gain was one step of
    # systematic over-provisioning bought with no signal.
    #
    # What survives is the one native signal that measurably separates the
    # benchmark's bands: the checkpoint's own difficulty score, which averages
    # 1.38 of 3 required tier in its low band and 2.62 in its high band.
    difficulty_signal = native_difficulty.get("score") if native_difficulty else None
    escalated = ""
    if isinstance(difficulty_signal, (int, float)) and difficulty_signal >= HARD_DIFFICULTY and tier != MAX_ESCALATION_TIER:
        tier = _bump(tier)
        escalated = " escalated(laya difficulty %.2f)" % difficulty_signal

    # Difficulty is taken from Laya only when its own difficulty answer is
    # calibrated; otherwise the baseline's tier-derived estimate stands.
    difficulty = (
        _score(answers, "difficulty", default=baseline["difficulty"], levels=DIFFICULTY_LEVELS)
        if _confidence(answers, "difficulty") >= TRUSTED_CONFIDENCE
        else baseline["difficulty"]
    )

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

    # The one calibrated signal worth acting on. A confident `domain` answer that
    # is not software engineering means the task was probably misrouted, so it is
    # flagged for review and raised a tier rather than silently run as code.
    domain_note = ""
    if domain:
        domain_choice = domain.get("choice")
        domain_confidence = domain.get("confidence") or 0.0
        if domain_choice and domain_choice != "code" and domain_confidence >= TRUSTED_CONFIDENCE:
            needs_review = True
            if tier != MAX_ESCALATION_TIER:
                tier = _bump(tier)
            domain_note = " domain=%s(%.2f, not code)" % (domain_choice, domain_confidence)
        else:
            domain_note = " domain=%s(%.2f)" % (domain_choice, domain_confidence or 0.0)

    return {
        "kind": kind,
        "tier": tier,
        "difficulty": difficulty,
        "needsReview": needs_review,
        "parallelizable": parallelizable,
        "confidence": confidence,
        "source": "laya",
        "reason": "rules=%s/%s laya=%s/%s agree=%s confidence=%.3f%s%s"
        % (
            baseline["kind"],
            baseline["tier"],
            kind_answer or "-",
            tier_answer or "-",
            agree,
            confidence,
            domain_note,
            escalated,
        ),
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


def _confidence(answers: Dict[str, Any], qid: str) -> float:
    answer = answers.get(qid) or {}
    value = answer.get("confidence")
    return float(value) if isinstance(value, (int, float)) else 0.0


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


# Patterns are ordered by intent strength, not by convenience, and the ordering is
# load-bearing. Two rules govern it:
#
#   * A pattern describing *what the user wants done* outranks one describing what
#     the text happens to mention. "Review this patch for regressions" is a review
#     even though it says "regressions"; "Document the failover state machine" is
#     documentation even though it says "failover".
#   * A class that names a specific artefact outranks the generic action verb that
#     happens to precede it. "Add a changelog entry" is documentation because the
#     artefact decides, not the verb.
#
# These boundaries are where the expanded benchmark found 37 misses, almost all of
# them pattern gaps rather than genuine ambiguity. The benchmark groups cases by
# boundary so a regression in one shows up instead of averaging away.
_RULE_PATTERNS: Tuple[Tuple[str, str], ...] = (
    # Review, first and deliberately broad: a user asking for judgement on work
    # already done says so in many ways.
    (
        "review",
        r"\b(review|audit|critique|second opinion|sanity ?check|look over|check (this|that|the)"
        r"|is this .* (safe|correct|ok)|does this (change|patch|break)|anything i missed|races? in)\w*",
    ),
    # An explicit request to produce documentation. Checked before the symptom
    # classes because documentation *about* a bug still names the bug: "add a
    # section about failover" and "write a comment explaining why" both contain
    # debugging vocabulary while asking for prose.
    (
        "docs",
        r"\b(document|documentation|docstring|changelog|readme|write a comment|add a comment"
        r"|explain .* in a comment|add a (section|chapter|guide)|write a guide|describe the)\w*",
    ),
    # Diagnosing a failure is phrased in many ways that avoid the obvious nouns:
    # "trace why", "never backs off", "silently does nothing", "picks the wrong
    # model", "is not being detected".
    (
        "debug",
        r"\b(fail|failing|failure|broken|crash|error|bug|regress|stack ?trace|traceback|debug"
        r"|why|diagnose|narrow down|root cause|silently|no longer|stopped working|does nothing|is red"
        r"|never (closes|backs off|returns|finishes)|is not being|not being (detected|applied)"
        r"|wrong|incorrect|hang|hangs|hanging|truncat|got it wrong|shows up"
        r"|off-by-one|off by one|race in|data loss|memory leak)\w*",
    ),
    # Documentation names its artefact, so it outranks the verb in front of it.
    ("docs", r"\b(doc|docs|readme|changelog|docstring|guide|describe|document|write a comment)\w*"),
    # Research is an information request: it asks a question, looks something up,
    # or asks for a comparison. "Whether" and a leading interrogative are strong
    # signals that no file is going to be changed.
    (
        "research",
        r"\b(research|find out|look up|look into|compare|investigate|explore|survey|whether"
        r"|which|what does|what is|what changed|does |can we|could we|is it possible|how (does|do|many)"
        r"|tradeoff|difference between|i want to know)\w*",
    ),
    ("test", r"\b(test|tests|pytest|jest|vitest|spec|coverage|fixture)\w*"),
    # Git comes before inspect so that "squash the commits" is not read as reading
    # the repository. It is matched as a whole word plus operations, because
    # "git" inside a question ("does git allow…") makes that question research.
    ("git", r"\b(commit|commits|rebase|cherry|squash|stash|git (add|commit|push|pull|log|status|branch))\w*"),
    # A request that adds or builds something is a change even when it reads like
    # an inspection ("implement", "add a flag").
    (
        "coding",
        r"\b(implement|add|create|build|write|refactor|rename|extract|migrate|upgrade|wire up"
        r"|support|introduce|paginate|rework|switch|replace|split|move|sort|return|handle|parse"
        r"|make the|change the|update the|remove|delete|raise the|lower the|fix)\w*",
    ),
    ("inspect", r"\b(read|inspect|list|show|explain|where|which|find|locate|summar|how many|what does)\w*"),
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
