#!/usr/bin/env python3
"""PreToolUse hook for the Agent tool: the vigil subagent model policy.

The owner's ruling: delegated vigil roles pin their own model so the
choice survives a missed `AGENTS.md` read — Sonnet for a bounded
implementation slice (`vigil-builder`), for filing issues from a settled
brief (`vigil-issue-filer`), and for auditing a filed batch against the
board (`vigil-board-auditor`), Opus for escalation, semantic
review, and test-keeping (`vigil-escalation`, `vigil-reviewer`,
`vigil-test-keeper`). This hook keeps a spawn from working around that:
an explicit `model` on a pinned role, an implementation brief handed to
anything else, or an escalation spawn whose record does not actually say
what it is escalating from — either every handoff field filled with this
slice's facts, or a `Risk area:` line naming both a category and the
reason when the slice starts on escalation instead of taking over a
failed attempt.

Reading a prompt as an implementation assignment is a heuristic, not a
parse: the brief template's own markers, an instruction to commit, or a
build verb next to a repository file. Position is what separates an
instruction from prose in the last two -- "and commit the fix" assigns
work, "the changes in commit 2248b048" does not -- so both are read in
imperative position and nowhere else, and after a discourse cue a build
verb also has to take an object, because "and" coordinates nouns as
readily as clauses ("compare the create and delete paths"). Three kinds
of assignment are deliberately not caught, because the only rules broad
enough to catch them also deny ordinary prompts, and a gate that denies
ordinary prompts gets worked around: one that names no file and asks for
no commit — "update the docs"; one whose verb never lands in imperative
position — "your task is to update the hook"; and one that quotes its
git command at the head of a line, where the backtick breaks the lead.
The mirror of the second is what the position rule buys: "summarize the
write path in apps/.../thing.ts" is research, not a write instruction,
and so is "explain why git commit -a is forbidden". The built-in
read-only agent types are exempt from the rule outright: they cannot edit
or commit, so a brief-shaped prompt to one of them is research.

It never blocks on its own failure: any internal error exits 0 (fail
open), same as `preflight.py`. It is Claude-only — the `Agent` tool has no
Codex equivalent, so every other `tool_name` passes through untouched.
"""
from __future__ import annotations

import json
import re
import sys

PINNED = {
    "vigil-builder",
    "vigil-escalation",
    "vigil-reviewer",
    "vigil-test-keeper",
    "vigil-issue-filer",
    "vigil-board-auditor",
}
PINNED_MODEL = {
    "vigil-builder": "sonnet",
    "vigil-escalation": "opus",
    "vigil-reviewer": "opus",
    "vigil-test-keeper": "opus",
    "vigil-issue-filer": "sonnet",
    "vigil-board-auditor": "sonnet",
}
BRIEF_MARKERS = ("## Checkout and ownership", "Owned writable paths", "# Brief:")
# The built-in agent types that hold no edit or commit tools. A brief-shaped
# prompt to one of them is a research assignment, not a way around the pinned
# builder, so rule 3 does not apply to them at all.
READ_ONLY_TYPES = {"Explore", "Plan", "claude-code-guide", "statusline-setup"}

# What marks a free-form prompt as an implementation assignment, for the prompts
# that never went near the template. A build verb...
BUILD_VERB = (
    r"implement|edit|modify|refactor|rewrite|fix|add|remove|delete|rename"
    r"|write|update|create|change|replace"
)
# ...read in imperative position, and nowhere else. Every one of these words is
# also an ordinary English noun or adjective -- "the write path", "an update on
# the docs", "the add flow", "a fix" -- and a research prompt about code is
# exactly the prompt that also names a file, so a verb matched anywhere denied
# `summarize the write path in apps/.../thing.ts`. Imperative position is
# structural -- the prompt's first word, the first word of a line or of a list
# item, the first word of a new sentence -- or discursive: the word straight
# after a discourse cue (`please update ...`, `then edit ...`, `and add ...`).
STRUCTURAL_LEAD = (
    r"(?:\A|\n)[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+)?"
    r"|[.!?;]+[ \t]+"
)
DISCOURSE_CUE = r"\b(?:please|then|and|also|now|first|next|finally)[,:]?[ \t]+"
IMPERATIVE_LEAD = rf"{STRUCTURAL_LEAD}|{DISCOURSE_CUE}"
# What a cue-led verb has to be followed by to be read as one. `and` is the cue
# that does double duty: it coordinates clauses (`read the brief and update the
# hook`) and it coordinates nouns (`compare the create and delete paths`), and
# in the second the word after the cue is a modifier, not an instruction. A real
# object is what separates them -- an imperative takes a determiner or names a
# target outright -- so a cue-led verb counts only when a determiner, an issue
# number, a path or a filename follows it. `delete paths` and `create endpoint`
# carry none and stay prose. The structural positions ask for no object: a line
# or sentence that opens with a build verb is an instruction whatever follows.
VERB_TARGET = (
    r"(?:(?:the|a|an|this|that|these|those|its|our|your|every|each|all|any)\b"
    r"|#\d|[\w.-]*/|\.?[\w-]+\.[A-Za-z0-9]{1,6}\b)"
)
IMPERATIVE_BUILD_VERB = re.compile(
    rf"(?:{STRUCTURAL_LEAD})(?:{BUILD_VERB})\b"
    rf"|(?:{DISCOURSE_CUE})(?:{BUILD_VERB})\b[ \t]+{VERB_TARGET}",
    re.IGNORECASE,
)
# ...next to a file this repository holds: a slash-bearing token whose last
# segment carries an extension (`packages/ledger/src/journal.ts`,
# `.codex/hooks/agent_policy.py`), which leaves `.../issues/560` alone...
REPO_PATH = re.compile(r"\S*/\S*\.[A-Za-z0-9]{1,6}(?![\w/])")
# ...or a bare filename, where only the extensions this repo actually edits
# count, so ordinary prose ("v1.2", "see §4.2") is not read as a path.
BARE_FILE = re.compile(r"\b[\w.-]+\.(?:tsx?|py|mdx?|json|toml|sql|[mc]?js|ya?ml)\b", re.IGNORECASE)
# ...or one of the files this repository keeps with no extension at all, where
# the name is the whole filename (`Update Dockerfile to copy the manifest` names
# a file as surely as any path). An optional path may lead it: this repository
# holds `docker/postgres/Dockerfile`, and `./Dockerfile` is how a parent writes
# the root one -- `REPO_PATH` wants an extension and finds neither, so a rule
# that refused a preceding slash left the most exact spelling of the filename
# unrecognized. Deliberately case-sensitive and matched as a whole final
# segment: `LICENSE` and `Dockerfile` are files, `the license this repo ships
# under` is prose, and `Dockerfiles` is neither. A URL whose tail happens to be
# one of these names (`https://example.com/Dockerfile`) matches too -- the cost
# of reading a path prefix without parsing it, and a link to a Dockerfile beside
# a build verb is not the prompt this rule gets wrong in practice.
KNOWN_FILE = re.compile(
    r"(?<![\w.-])(?:\.?\.?/)?(?:[\w.-]+/)*(?:Dockerfile|Makefile|LICENSE|CODEOWNERS)(?![\w-])"
    r"|(?<![\w.-])(?:\.?\.?/)?(?:[\w.-]+/)*"
    r"\.(?:gitignore|dockerignore|env(?:\.example)?)(?![\w-])"
)

# Or an instruction to commit, which no read-only assignment carries. `commit`
# alone is a noun in review prose -- "the commit that broke it", "review the
# changes in commit 2248b048" -- and a review prompt is exactly the prompt that
# also says `changes`, so the bare word counts only where the prompt is giving
# an instruction: the same imperative position the build verbs are read in
# (`and commit the fix`, `Then commit.`, `- commit by pathspec`). The git
# command itself is read the same way and for the same reason: `Explain why git
# commit -a is forbidden in AGENTS.md` quotes the command to ask about it, and a
# prompt about a forbidden command is exactly the prompt that spells it out. One
# spelling is an instruction wherever it sits -- the brief template's own
# `commit by pathspec`, which no prose uses. The cost of the position rule is a
# command quoted at the head of a line -- "`git commit -m x` is forbidden" and
# "run `git commit` once CI is green" read the same way, because the backtick
# breaks the lead in both. That is wrong in the direction that lets a prompt
# through, which is the direction this gate is deliberately wrong in.
GIT_COMMIT = re.compile(rf"(?:{IMPERATIVE_LEAD})git\s+commit\b", re.IGNORECASE)
IMPERATIVE_COMMIT = re.compile(rf"(?:{IMPERATIVE_LEAD})commit\b", re.IGNORECASE)
COMMIT_BY_PATHSPEC = re.compile(r"\bcommit\s+by\s+pathspec\b", re.IGNORECASE)

# The handoff record of the "## Escalation record" section in
# .agents/skills/vigil-agent-build/templates/agent-brief.md. Route A: a worker
# taking over a failed attempt must arrive with all seven, each filled in --
# these are exactly the facts that keep it from restarting blindly. `CI output`
# is one of them because `AGENTS.md` lists CI contradicting the builder's model
# as a reason to escalate at all: a record that stops at the unresolved question
# sends the worker to reconstruct the failure it was escalated over. `none` is a
# legitimate answer when no run exists, with the reason it does not.
RECORD_FIELDS = (
    "Originating brief",
    "Trigger",
    "Findings",
    "Attempted approaches",
    "Changed files",
    "CI output",
    "Unresolved question",
)
# The template's alternative, for a slice owned by `vigil-escalation` from the
# start. Route B: one line is the whole record, and the seven handoff fields above
# it in the pasted template stay unfilled precisely because nothing failed yet --
# so a `Risk area:` line is sufficient on its own. Being the whole record, it has
# to earn that: a bare category names no risk the worker could not read off the
# branch, so the line must carry the reason too.
RISK_AREA_FIELD = "Risk area"
# How many `\w+` tokens a `Risk area:` value must carry: a category plus a short
# reason. `migration` (1), `none` (1) and `authz — new route` (3) are categories;
# `migration — 0134 rewrites a hot table` (6) is a rationale.
RISK_AREA_MIN_WORDS = 4
# And which categories open the route at all. `AGENTS.md` limits a slice that
# starts on escalation to the ledger, policy, execution, signer, migration,
# authorization, persistence, replay, idempotency, and reconciliation risk
# areas; a rationale the writer believes does not make an ordinary slice one
# of those, so the category is checked against this list and everything else
# starts on `vigil-builder`.
RISK_AREAS = (
    "ledger",
    "policy",
    "execution",
    "signer",
    "migration",
    "authz",
    "authorization",
    "persistence",
    "replay",
    "idempotency",
    "reconciliation",
)
RISK_AREAS_TEXT = ", ".join(f"`{area}`" for area in RISK_AREAS)
# Where the leading category ends: an em or en dash, a colon, semicolon or
# comma, or a hyphen that is not inside a word -- so ` - ` and `--` separate a
# category from its rationale, while a hyphen inside a single word (as in a
# category like `co-located`) does not.
RISK_CATEGORY_END = re.compile(r"[—–:;,]|(?<!\w)-|-(?!\w)")

# What marks a prompt as carrying a handoff record at all (Route A).
ESCALATION_LINE = re.compile(
    r"^[ \t]*(?:[-*+][ \t]+)?Escalation[ \t]*:", re.MULTILINE | re.IGNORECASE
)
ESCALATION_HEADING = re.compile(r"^[ \t]*#{1,6}[ \t]+Escalation\b", re.MULTILINE | re.IGNORECASE)

HEADING_LINE = re.compile(r"^[ \t]*#{1,6}[ \t]+\S")
# `Field: value`, optionally bullet- or number-prefixed and indented, as the
# record's fields are written in the template and in real briefs.
LABEL_LINE = re.compile(
    r"^(?P<indent>[ \t]*)(?:[-*+][ \t]+|\d+[.)][ \t]+)?"
    r"(?P<label>[^:<>\n]{1,60}?)[ \t]*:[ \t]*(?P<value>.*)$"
)

# A `<...>` chunk standing in for the root of a quoted path, e.g. the
# `<worktree>` of `<worktree>/.codex/hooks/agent_policy.py`: one token, no
# whitespace, `/` immediately after. Dropped before the placeholder check,
# because that shape is lowercase prose in brackets like the template's own.
PATH_PLACEHOLDER = re.compile(r"<[^<>\s]+>(?=/)")
# The template's own placeholder shape and nothing else: lowercase prose in angle
# brackets, standing on its own rather than hanging off a word. Each of the three
# exclusions keeps angle brackets a real record legitimately carries out of it --
# no word character or `>` immediately before (`Record<string, X>`,
# `Array<string>` are generics), a lowercase first letter (`<CharacterCard />` is
# a tag), and no colon inside (`<https://github.com/...>` is a Markdown autolink).
# A bare lowercase tag (`<div>`) is indistinguishable from `<why>` and still reads
# as a placeholder -- unavoidable, since the template's own placeholders are that
# same shape; a record naming one writes it as prose instead.
PLACEHOLDER = re.compile(r"(?<![\w>])<[a-z][^<>:]*>")

ABSENT = "absent"
UNFILLED = "unfilled"
# Route B only: real words, but too few to be a reason -- `Risk area: migration`.
NO_RATIONALE = "no rationale"
# Route B only: a category and a reason, but the category is not one of the
# areas that may start on escalation -- `Risk area: styling — this button needs
# careful visual polish`.
NOT_RISK_AREA = "not a risk area"
FILLED = "filled"
# Which reading wins when a field appears more than once, worst to best: a field
# that is there beats one that is not, real content beats template prose, and a
# named category with a reason beats a bare one. Only FILLED opens a route, so
# the order below decides which complaint the deny message makes, not whether it
# denies.
STATE_RANK = {ABSENT: 0, UNFILLED: 1, NO_RATIONALE: 2, NOT_RISK_AREA: 3, FILLED: 4}


def _has_brief(prompt: str) -> bool:
    """True when the prompt carries the brief template's own vocabulary."""
    return any(marker in prompt for marker in BRIEF_MARKERS)


def _has_commit_signal(prompt: str) -> bool:
    """True when the prompt tells the worker to commit, not when it talks about a commit.

    `Review the changes in commit 2248b048 and summarize them` is research and
    names a commit, and so is `Explain why git commit -a is forbidden in
    AGENTS.md`; `and commit the fix`, `Then commit.`, a line that opens
    `git commit -m ...` and `commit by pathspec` are instructions.
    """
    return bool(
        GIT_COMMIT.search(prompt)
        or COMMIT_BY_PATHSPEC.search(prompt)
        or IMPERATIVE_COMMIT.search(prompt)
    )


def _names_a_repo_file(prompt: str) -> bool:
    return bool(REPO_PATH.search(prompt) or BARE_FILE.search(prompt) or KNOWN_FILE.search(prompt))


def _imperative_build_verb(prompt: str) -> bool:
    """True when a build verb appears where the prompt is giving an instruction.

    `edit the hook` is an assignment; `the write path`, `an update on the docs`
    and `the add flow` are the same words used as nouns, and the second kind is
    what a research prompt about code is made of. Position is the only signal
    that separates them without a parse, so the verb counts at the start of the
    prompt, of a line, of a list item or of a sentence, or straight after a
    discourse cue -- and is ignored anywhere a determiner or another word put
    it in the middle of a noun phrase.

    After a cue the verb needs an object too. `and` joins clauses and noun
    phrases alike, so `read the brief and update the hook` is an instruction
    while `compare the create and delete paths` is one noun phrase; a following
    determiner, issue number, path or filename is what tells them apart. The
    structural positions need no object: nothing but an instruction opens a line
    with `rewrite`.
    """
    return bool(IMPERATIVE_BUILD_VERB.search(prompt))


def _is_implementation_brief(prompt: str) -> bool:
    """True when this prompt assigns implementation work.

    Three readings, any one of which is enough: the template's markers, an
    instruction to commit, or a build verb in imperative position next to a
    file in this repository. The last two are what catch the assignment a
    parent types by hand -- `Implement #560; edit .codex/hooks/agent_policy.py
    and commit the fix` -- which carries no template text at all and is exactly
    the spawn the pinned builder exists to take. A build assignment naming
    neither a file nor a commit is not caught, and neither is one whose verb
    never reaches imperative position; see the module docstring for why both
    limits are deliberate.
    """
    if _has_brief(prompt):
        return True
    if _has_commit_signal(prompt):
        return True
    return _imperative_build_verb(prompt) and _names_a_repo_file(prompt)


def _normalize_words(text: str) -> str:
    """Lowercase text down to its words: `- **Changed files**` -> `changed files`,
    `persistence/replay correctness` -> `persistence replay correctness`."""
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


# Each approved area as a pattern anchored at the start of the normalized
# category, so a category matches however the writer spelled it -- `migrations`
# (plural), `persistence/replay correctness` (the pairing plus a noun) -- and
# only when the category leads with that area rather than merely containing
# it. The anchor is the whole rule: read anywhere in the category,
# `non-authorization` and `unrelated to migration` opened the route on the
# very word they negate. `styling`, `ui` and `docs` match nothing either way.
RISK_AREA_PATTERNS = tuple(
    re.compile(r"\A" + _normalize_words(area).replace(" ", r"\s+") + r"s?\b")
    for area in RISK_AREAS
)


def _risk_category(value: str) -> str:
    """A `Risk area:` value's leading category: the text before its first
    separator, or its first word when the value carries none."""
    end = RISK_CATEGORY_END.search(value)
    if end:
        return value[: end.start()].strip()
    words = value.split()
    return words[0] if words else ""


def _is_approved_risk_area(value: str) -> bool:
    """True when the value's leading category begins with an area `AGENTS.md` lets
    a slice start on escalation for -- `non-authorization` and `unrelated to
    migration` name none, however approved the word inside them is."""
    category = _normalize_words(_risk_category(value))
    return any(pattern.search(category) for pattern in RISK_AREA_PATTERNS)


def _label_matches(label: str, field: str) -> bool:
    """True when `label` names `field`, allowing the writer's own trailing words
    (`Changed files so far:` is still the changed-files field)."""
    normalized = _normalize_words(label)
    target = _normalize_words(field)
    return normalized == target or normalized.startswith(target + " ")


def _is_filled_value(value: str, min_words: int = 1) -> bool:
    r"""True when `value` carries this slice's own facts rather than template text.

    The template writes every field as lowercase angle-bracket prose -- `<why>`,
    `<paths touched so far>` -- so a chunk of that shape still in a value is
    template text that survived the edit: a half-edited
    `Risk area: migration — <why>.` names a category but never the reason, which
    is the whole point of the field. `PLACEHOLDER` matches that shape and nothing
    else, so angle brackets a record legitimately carries leave it filled: a
    Markdown autolink, a JSX tag, a TypeScript generic, and a quoted path root
    (`<worktree>/...`, dropped by `PATH_PLACEHOLDER` before the check).

    `min_words` is how many `\w+` tokens must survive. One -- any real content at
    all -- is the rule for the seven handoff fields. Route B's `Risk area:` line is
    the whole record on its own, so it asks for four: enough that the line has to
    carry a reason and not just a category.
    """
    remainder = PATH_PLACEHOLDER.sub("", value)
    if PLACEHOLDER.search(remainder):
        return False
    return len(re.findall(r"\w+", remainder)) >= min_words


def _indent_width(line: str) -> int:
    return len(line) - len(line.lstrip(" \t"))


def _filled_value(
    lines: list[str],
    boundaries: set[int],
    index: int,
    match: "re.Match",
    min_words: int = 1,
) -> str | None:
    """The filled value of the field starting at `index`, or None when it has none.

    The value may sit on the field's own line, or below it as an indented block
    (`Findings:` followed by a numbered list) -- a shape real briefs use. Only
    lines indented deeper than the field count, so a field left empty above
    ordinary prose stays unfilled. Continuation lines answer to the same
    placeholder and word-count rules as the field's own line: a block whose every
    line is still template prose fills nothing.

    The text is returned rather than a bare yes, because Route B has a second
    question to ask of the same value -- which area it names.
    """
    value = match.group("value")
    if _is_filled_value(value, min_words):
        return value
    indent = len(match.group("indent"))
    for j in range(index + 1, len(lines)):
        if j in boundaries:
            return None
        line = lines[j]
        if not line.strip():
            continue
        if _indent_width(line) <= indent:
            return None
        if _is_filled_value(line, min_words):
            return line
    return None


def _block_is_filled(
    lines: list[str],
    boundaries: set[int],
    index: int,
    match: "re.Match",
    min_words: int = 1,
) -> bool:
    return _filled_value(lines, boundaries, index, match, min_words) is not None


def _field_state(
    lines: list[str], boundaries: set[int], index: int, match: "re.Match", field: str
) -> str:
    """One labelled field's reading: FILLED, NOT_RISK_AREA, NO_RATIONALE, or UNFILLED.

    Every field but `Risk area:` is filled by any content that is not template
    prose -- the seven handoff fields are read together, and a short one is still a
    fact the next worker did not have. `Risk area:` is read alone, so it has two
    more questions to answer. It has to clear `RISK_AREA_MIN_WORDS`; clearing the
    placeholder rule but not the word count is NO_RATIONALE, a named category with
    the reason left out. And the category it names has to be one the policy lets a
    slice start on: a rationale the writer finds convincing is not the test, or
    any slice can talk its way onto the escalation role. Each reading gets its own
    sentence in the deny message.
    """
    if field != RISK_AREA_FIELD:
        return FILLED if _block_is_filled(lines, boundaries, index, match) else UNFILLED
    value = _filled_value(lines, boundaries, index, match, RISK_AREA_MIN_WORDS)
    if value is not None:
        return FILLED if _is_approved_risk_area(value) else NOT_RISK_AREA
    return NO_RATIONALE if _block_is_filled(lines, boundaries, index, match) else UNFILLED


def _scan_record(prompt: str):
    """Find the prompt's record fields: its lines, where each field's block ends,
    and the labelled lines themselves keyed by line number."""
    fields = RECORD_FIELDS + (RISK_AREA_FIELD,)
    lines = prompt.splitlines()

    labelled: dict[int, tuple[str, "re.Match"]] = {}
    for index, line in enumerate(lines):
        match = LABEL_LINE.match(line)
        if not match:
            continue
        field = next((f for f in fields if _label_matches(match.group("label"), f)), None)
        if field:
            labelled[index] = (field, match)

    # A field's block ends at the next record field or the next Markdown heading.
    boundaries = set(labelled) | {i for i, line in enumerate(lines) if HEADING_LINE.match(line)}
    return lines, boundaries, labelled


def _rejected_risk_category(prompt: str) -> str:
    """The category of the first `Risk area:` value that carries a rationale but
    names no approved area -- what the NOT_RISK_AREA deny message quotes back."""
    lines, boundaries, labelled = _scan_record(prompt)
    for index in sorted(labelled):
        field, match = labelled[index]
        if field != RISK_AREA_FIELD:
            continue
        value = _filled_value(lines, boundaries, index, match, RISK_AREA_MIN_WORDS)
        if value is not None and not _is_approved_risk_area(value):
            return _risk_category(value)
    return ""


def _record_states(prompt: str) -> dict[str, str]:
    """Map every record field in `prompt` to ABSENT, UNFILLED, NO_RATIONALE,
    NOT_RISK_AREA or FILLED."""
    fields = RECORD_FIELDS + (RISK_AREA_FIELD,)
    lines, boundaries, labelled = _scan_record(prompt)

    states = {field: ABSENT for field in fields}
    for index, (field, match) in labelled.items():
        state = _field_state(lines, boundaries, index, match, field)
        if STATE_RANK[state] > STATE_RANK[states[field]]:
            states[field] = state  # the best occurrence of a repeated field wins
    return states


def _escalation_denial(prompt: str) -> str | None:
    """Return why this escalation prompt carries no usable record, or None to allow it."""
    states = _record_states(prompt)

    if states[RISK_AREA_FIELD] == FILLED:
        return None  # Route B: the handoff fields do not apply to a slice starting here

    marked = bool(ESCALATION_LINE.search(prompt) or ESCALATION_HEADING.search(prompt))
    missing = [field for field in RECORD_FIELDS if states[field] == ABSENT]
    unfilled = [field for field in RECORD_FIELDS if states[field] == UNFILLED]
    if marked and not missing and not unfilled:
        return None  # Route A: a complete handoff record

    if not marked and not unfilled and missing == list(RECORD_FIELDS):
        route_a = (
            "not attempted — add an `Escalation:` line or a `## Escalation` heading plus all "
            "seven fields, each filled with this slice's facts: " + ", ".join(RECORD_FIELDS) + "."
        )
    else:
        problems = []
        if missing:
            problems.append("missing: " + ", ".join(missing))
        if unfilled:
            problems.append(
                "present but unfilled (empty, or still carrying a template `<placeholder>` "
                "such as `<paths touched so far>`): " + ", ".join(unfilled)
            )
        if not marked:
            problems.append("no `Escalation:` line or `## Escalation` heading marks the record")
        route_a = "; ".join(problems) + "."

    if states[RISK_AREA_FIELD] == ABSENT:
        route_b = (
            "not attempted — add a `Risk area:` line saying why this slice starts on escalation, "
            "e.g. `Risk area: migration — 0134 rewrites a hot table`."
        )
    elif states[RISK_AREA_FIELD] == NOT_RISK_AREA:
        named = _rejected_risk_category(prompt)
        route_b = (
            f"the `Risk area:` line names {f'`{named}`' if named else 'an area'}, which is not "
            "one of the areas a slice may start on escalation for — those are "
            f"{RISK_AREAS_TEXT}. A slice outside them, however carefully it has to be done, "
            "starts on `vigil-builder` (Sonnet), which returns an escalation record if it "
            "fails; escalate then."
        )
    elif states[RISK_AREA_FIELD] == NO_RATIONALE:
        route_b = (
            "the `Risk area:` line is present but without a rationale — `Risk area: migration` "
            "or `Risk area: none` names a category and no reason, and on this route that line "
            "is the entire record; say why this slice starts on escalation, e.g. "
            "`Risk area: migration — 0134 rewrites a hot table`."
        )
    else:
        route_b = (
            "the `Risk area:` line is present but unfilled (empty, or still carrying a template "
            "`<placeholder>` — choosing the category and leaving `<why>` is still unfilled); "
            "name the actual risk, e.g. `Risk area: migration — 0134 rewrites a hot table`."
        )

    return "\n".join(
        [
            "[vigil agent policy] `vigil-escalation` needs a record of what it is escalating "
            "from, and neither route is complete in this prompt.",
            f"Route A (taking over a failed attempt): {route_a}",
            f"Route B (this slice starts on escalation): {route_b}",
            "Fill one of the two routes with this slice's actual facts and retry.",
        ]
    )


def check(tool_input: dict) -> str | None:
    """Return a deny reason for this Agent spawn, or None to allow it.

    Pure and side-effect free so tests can call it directly; `main()` wires
    it to stdin/stdout/exit-code for the actual hook.
    """
    subagent_type = tool_input.get("subagent_type") or ""
    model = tool_input.get("model") or ""
    prompt = tool_input.get("prompt") or ""

    if subagent_type in PINNED and model:
        return (
            f"[vigil agent policy] `{subagent_type}` pins its own model "
            f"({PINNED_MODEL[subagent_type]}); this spawn passed `model: {model}`, "
            "which would override that pin.\n"
            "Remove `model` from the call, or use `general-purpose` with an explicit "
            "model for an ad-hoc task that isn't one of the pinned vigil roles."
        )

    if subagent_type == "vigil-escalation":
        denial = _escalation_denial(prompt)
        if denial:
            return denial

    if (
        subagent_type not in PINNED
        and subagent_type not in READ_ONLY_TYPES
        and _is_implementation_brief(prompt)
    ):
        return (
            "[vigil agent policy] this prompt assigns implementation work — a brief, an "
            "instruction to commit, or a build instruction naming a file in this repository "
            f"— and `{subagent_type or '(no subagent_type)'}` is not one of the pinned "
            "roles.\n"
            "Implementation briefs go to `vigil-builder` (Sonnet) or `vigil-escalation` "
            "(Opus; needs a filled escalation record, or a `Risk area:` line naming an "
            f"approved risk area — {RISK_AREAS_TEXT} — and why). A read-only research "
            "prompt belongs on `Explore` or `Plan`, which this rule exempts."
        )

    return None


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0

    if not isinstance(payload, dict):
        return 0

    if payload.get("tool_name") != "Agent":
        return 0

    tool_input = payload.get("tool_input") or {}

    try:
        deny = check(tool_input)
    except Exception as exc:  # never break a tool call on our own bug
        print(f"[vigil agent policy] skipped: {exc}", file=sys.stderr)
        return 0

    if deny:
        print(deny, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
