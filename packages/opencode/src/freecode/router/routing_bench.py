"""Routing benchmark for FreeCode's Laya integration.

Run from the bridge directory:

    FREECODE_LAYA_CACHE=<workspace>/.runtime/hf-cache \
      <workspace>/.runtime/laya-venv/bin/python routing_bench.py --coverage --show-misses

Why this exists
---------------
The shipped `typed-decisions` checkpoint is measurably out of distribution on
FreeCode's question set while being well calibrated on its own presets. Every
change to question wording, option criteria, or decision policy must be scored
here rather than argued about, and two separate questions have to be answered:

* **Accuracy** — is the model right? (`rules-only`, `current`, `laya-style`)
* **Coverage** — is it confident enough to be believed? (`--coverage`)

A question set can be accurate and still useless, which is what the measurements
show. `rules-only` is the floor to beat: a variant that does not beat the
deterministic rules is not earning its forward pass.

`tier>=min` is the safety metric (under-provisioning costs a failed turn) and
`tier=exact` is the cost metric (over-provisioning spends tokens). Reporting only
the first hides systematic over-provisioning, which is how an earlier blanket
escalation looked like a gain of eight points while actually being pure overspend.
"""

from __future__ import annotations

import argparse
import os
import statistics
import sys
from typing import Any, Dict, List, Optional, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import cache  # noqa: E402
import sdk  # noqa: E402

# sys.path first, then the cache environment, then anything that imports `laya`.
sdk.install()
cache.configure()

from questions import difficulty_question, domain_question, render_state  # noqa: E402
from route import Classifier, decision_from_answers, fallback_decision  # noqa: E402

TRUST_THRESHOLD = 0.35

TIER_ORDER = ["local", "fast", "standard", "strong", "max"]

TASK_AGENT = "coder"
TOOLS = ["read", "edit", "bash"]

# (task text, expected kind, minimum acceptable tier)
CASES: List[Tuple[str, str, str]] = [
    # -- debug: diagnose a failure -------------------------------------------------
    ("Fix the failing data loader test caused by incorrect LOSO subject indexing", "debug", "strong"),
    ("The server crashes with a KeyError when the cache is cold", "debug", "strong"),
    ("Trace why the websocket reconnect loop never backs off", "debug", "strong"),
    ("Users report the export button silently does nothing on Safari", "debug", "strong"),
    # -- test ----------------------------------------------------------------------
    ("Add unit tests for the retry helper", "test", "standard"),
    ("Raise coverage on the payments module to 80 percent", "test", "standard"),
    ("Write a fixture that builds a temporary git repository", "test", "standard"),
    # -- coding --------------------------------------------------------------------
    ("Add a --json flag to the export command", "coding", "standard"),
    ("Refactor the entire authentication architecture to support multi-tenant sessions", "coding", "max"),
    ("Implement pagination for the user list endpoint", "coding", "standard"),
    ("rename the variable foo to bar in utils.ts", "coding", "fast"),
    ("Design a plugin system for third-party providers", "coding", "max"),
    # -- inspect -------------------------------------------------------------------
    ("List every file under src and summarise what each module does", "inspect", "fast"),
    ("Where is the retry logic implemented", "inspect", "fast"),
    ("Explain how sessions are persisted between restarts", "inspect", "fast"),
    ("Show me the database schema for the orders table", "inspect", "fast"),
    # -- research ------------------------------------------------------------------
    ("Find out whether the library supports streaming responses", "research", "fast"),
    ("Compare the two pagination approaches and recommend one", "research", "standard"),
    ("Look up the current rate limits for the provider API", "research", "fast"),
    # -- review --------------------------------------------------------------------
    ("Review this patch for regressions and missing test coverage", "review", "strong"),
    ("Audit the permission checks in the file server for bypasses", "review", "strong"),
    ("Give a second opinion on this schema migration", "review", "strong"),
    # -- docs ----------------------------------------------------------------------
    ("Add a changelog entry and README section for the new flag", "docs", "standard"),
    ("Document the public API of the client package", "docs", "standard"),
    # -- git -----------------------------------------------------------------------
    ("Rebase this branch onto main and resolve the conflicts", "git", "standard"),
    ("Squash the last five commits into one", "git", "fast"),
    ("Cherry-pick the hotfix onto the release branch", "git", "standard"),
]


def route_state(task: str) -> Dict[str, Any]:
    return {"agent": TASK_AGENT, "task": task, "tools": list(TOOLS)}


def variant_rules_only() -> Dict[str, Any]:
    """No model at all: the deterministic rules, which are the floor to beat."""
    return {}


def variant_current() -> Dict[str, Any]:
    from questions import questions

    return questions()


def variant_laya_style() -> Dict[str, Any]:
    """Phrasing that mirrors the checkpoint's own presets.

    Differences from `variant_current`, each taken from a preset the checkpoint
    demonstrably handles well: question-form instructions instead of imperatives,
    the state variable named `request` to match the presets' placeholder, every
    choice option carrying a description rather than a bare label, and fewer more
    separated options.
    """
    return {
        "kind": {
            "type": "choice",
            "instructions": "What kind of software engineering work does `request` describe?",
            "criteria": {
                "inspect": "reading or explaining code that already exists",
                "coding": "writing or changing production code",
                "debug": "finding the cause of a failure, crash or wrong behaviour",
                "test": "writing or fixing tests, fixtures or coverage",
                "research": "looking up outside information, docs or alternatives",
                "review": "judging code or a change someone else produced",
                "docs": "writing prose, comments, changelogs or documentation",
                "git": "version control operations such as rebase, merge or cherry-pick",
            },
        },
        "tier": {
            "type": "choice",
            "instructions": "Which language model is strong enough to handle `request`?",
            "criteria": {
                "local": "no reasoning needed, a pure lookup",
                "fast": "simple and mechanical, one obvious step",
                "standard": "ordinary engineering work of several steps",
                "strong": "subtle logic, architecture, or a hard bug",
                "max": "the hardest reasoning is required, frontier model only",
            },
        },
        "difficulty": {
            "type": "score",
            "instructions": "How hard is `request` for a language model?",
            "criteria": ["trivial", "easy", "moderate", "hard", "expert"],
        },
        "needs_review": {
            "type": "noul",
            "instructions": "Should a different model check the result before it is trusted?",
        },
        "parallelizable": {
            "type": "noul",
            "instructions": "Can this work be done independently of other work in flight?",
        },
    }


VARIANTS = {
    "rules-only": variant_rules_only,
    "current": variant_current,
    "laya-style": variant_laya_style,
}


def evaluate(classifier: Classifier, questions: Dict[str, Any], label: str) -> Dict[str, Any]:
    """Score one variant against the labelled cases.

    Reports the *policy's* output rather than the raw model answer: routing's job
    is to produce a decision, and the policy is allowed to override the model.
    """
    kinds_hit = 0
    tiers_adequate = 0
    tiers_exact = 0
    confidences: List[float] = []
    misses: List[str] = []

    for task, want_kind, min_tier in CASES:
        state = route_state(task)
        baseline = fallback_decision(state)

        if questions:
            rendered = render_state(state)
            answers = classifier._agent.predict(rendered, questions)["answers"]
            domain = classifier._agent.predict(rendered, domain_question())["answers"]["domain"]
            difficulty = classifier._agent.predict(rendered, difficulty_question())["answers"]["difficulty"]
            decision = decision_from_answers(answers, baseline, domain, difficulty)
            confidences.append(decision["confidence"])
        else:
            decision = baseline

        kinds_hit += decision["kind"] == want_kind
        tiers_adequate += tier_adequate(decision["tier"], min_tier)
        tiers_exact += decision["tier"] == min_tier
        if decision["kind"] != want_kind:
            misses.append(
                "%-34s want %-8s got %-8s (tier %s)" % (_clip(task), want_kind, decision["kind"], decision["tier"])
            )

    row: Dict[str, Any] = {
        "label": label,
        "kind_accuracy": kinds_hit / len(CASES),
        "tier_adequate": tiers_adequate / len(CASES),
        "tier_exact": tiers_exact / len(CASES),
        "misses": misses,
    }
    if confidences:
        row.update(
            confidence_mean=statistics.mean(confidences),
            confidence_median=statistics.median(confidences),
            confidence_min=min(confidences),
        )
    return row


def tier_adequate(got: str, minimum: str) -> bool:
    if got not in TIER_ORDER:
        return False
    # Under-provisioning costs a failed turn; over-provisioning only costs tokens.
    return TIER_ORDER.index(got) >= TIER_ORDER.index(minimum)


def _clip(text: str) -> str:
    return text if len(text) <= 34 else text[:31] + "..."


def coverage() -> Dict[str, Any]:
    """How often each FreeCode question lands above the trust threshold.

    This is the number that decides whether Laya can influence routing at all.
    A question set can be accurate and still useless, which is what is measured
    here: fine-grained accuracy is ~85% while almost nothing is ever confident
    enough to be believed.
    """
    from questions import questions

    classifier = Classifier(model="typed-decisions", device=os.environ.get("FREECODE_LAYA_DEVICE") or "mps")
    if not classifier.load():
        return {}

    trusted_kind = 0
    trusted_tier = 0
    for task, _, _ in CASES:
        answers = classifier._agent.predict(render_state(route_state(task)), questions())["answers"]
        trusted_kind += answers["kind"]["confidence"] >= TRUST_THRESHOLD
        trusted_tier += answers["tier"]["confidence"] >= TRUST_THRESHOLD

    return {"kind_trusted": trusted_kind / len(CASES), "tier_trusted": trusted_tier / len(CASES)}


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="FreeCode routing benchmark")
    parser.add_argument("--variant", action="append", choices=sorted(VARIANTS), default=None)
    parser.add_argument("--show-misses", action="store_true")
    parser.add_argument("--coverage", action="store_true", help="report how often each question is trusted")
    args = parser.parse_args(argv)

    names = args.variant or ["rules-only", "current", "laya-style"]
    classifier = Classifier(model="typed-decisions", device=os.environ.get("FREECODE_LAYA_DEVICE") or "mps")
    if not classifier.load():
        print("checkpoint unavailable: %s" % classifier.load_error, file=sys.stderr)
        return 1

    results = [evaluate(classifier, VARIANTS[name](), name) for name in names]

    print("%-12s %8s %10s %11s %9s %9s" % ("variant", "kind", "tier>=min", "tier=exact", "conf-med", "conf-min"))
    for row in results:
        median = row.get("confidence_median")
        low = row.get("confidence_min")
        print(
            "%-12s %7.0f%% %9.0f%% %10.0f%% %9s %9s"
            % (
                row["label"],
                row["kind_accuracy"] * 100,
                row["tier_adequate"] * 100,
                row["tier_exact"] * 100,
                "-" if median is None else "%.3f" % median,
                "-" if low is None else "%.3f" % low,
            )
        )

    if args.coverage:
        row = coverage()
        if row:
            print(
                "\nanswered above the %.2f trust threshold: kind %.0f%%, tier %.0f%%"
                % (TRUST_THRESHOLD, row["kind_trusted"] * 100, row["tier_trusted"] * 100)
            )

    if args.show_misses:
        for row in results:
            print("\n%s misses:" % row["label"])
            for miss in row["misses"]:
                print("  " + miss)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
