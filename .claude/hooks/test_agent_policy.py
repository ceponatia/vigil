"""Offline hook fixtures; never execute payload commands or contact services."""

import importlib.util
import json
import re
import subprocess
import sys
from pathlib import Path
import unittest

SCRIPT = Path(__file__).with_name("agent_policy.py").resolve()
SPEC = importlib.util.spec_from_file_location("agent_policy", SCRIPT)
HOOK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HOOK)

BRIEF_PROMPT = "\n".join([
    "# Brief: #999 -- do a bounded thing",
    "",
    "## Checkout and ownership",
    "- Owned writable paths: packages/ledger/src/journal.ts",
])

# A complete handoff record written as plain `Field: value` lines under an
# `Escalation:` line -- the prose-style shape a parent types by hand.
ESCALATION_PROMPT = "\n".join([
    "Escalation: two attempts left the same race; this needs a different approach.",
    "Originating brief: #999 -- do a bounded thing.",
    "Trigger: the second attempt failed exactly as the first did.",
    "Findings: the guard runs after the read, so concurrent writers still interleave.",
    "Attempted approaches: a service-layer guard, then a unique index; both missed concurrent inserts.",
    "Changed files: packages/ledger/src/journal.ts.",
    "CI output: verify run 34639284299 failed at the integration suite.",
    "Unresolved question: whether the lock belongs in the repo or the service.",
])

RISK_AREA_PROMPT = "Risk area: migration -- adds a NOT NULL column to a hot table."

# The same complete record, but below an opening instruction rather than first.
LATE_ESCALATION_PROMPT = "\n".join([
    "Continue #999 where the builder stopped.",
    "",
    "Escalation:",
    "- Originating brief: #999 -- do a bounded thing.",
    "- Trigger: two attempts left the same race.",
    "- Findings: the guard runs after the read, so concurrent writers still interleave.",
    "- Attempted approaches: a service-layer guard, then a unique index; both missed inserts.",
    "- Changed files: packages/ledger/src/journal.ts.",
    "- CI output: verify run 34639284299 failed at the integration suite on a8da4b87.",
    "- Unresolved question: where the lock belongs.",
])

# The record's heading with nothing under it: the shape that used to satisfy the gate.
HEADING_ONLY_PROMPT = "\n".join([
    "## Escalation record (escalation spawns only)",
    "",
    "Take over #999 from the builder and sort it out.",
])

# Two of the seven fields filled, the rest simply deleted rather than left as
# template text -- the partial record that used to satisfy the gate.
PARTIAL_ESCALATION_PROMPT = "\n".join([
    "Escalation:",
    "- Originating brief: #999 -- do a bounded thing.",
    "- Trigger: the builder stopped after one failed attempt.",
])

BRIEF_TEMPLATE = (
    Path(__file__).resolve().parents[2]
    / ".agents/skills/vigil-agent-build/templates/agent-brief.md"
)
ROLE_DIR = Path(__file__).resolve().parents[2] / ".claude/agents"

# The brief template is owned by a different skill, authored separately from this
# hook and its tests. Build every fixture below either way, so the rest of this
# file's tests run regardless of authoring order; only the two classes that assert
# facts about the template's actual, on-disk text (BriefMarkerTests,
# EscalationRecordTemplateTests) skip themselves when it is not there yet.
TEMPLATE_AVAILABLE = BRIEF_TEMPLATE.exists()
if TEMPLATE_AVAILABLE:
    _BRIEF_TEMPLATE_TEXT = BRIEF_TEMPLATE.read_text(encoding="utf-8")
else:
    _BRIEF_TEMPLATE_TEXT = "\n".join([
        "# Brief: <issue number and summary>",
        "",
        "## Checkout and ownership",
        "- Owned writable paths: <paths>",
        "- Allowed operations: <operations>",
        "",
        "## Escalation record (escalation spawns only)",
        "",
        "- Originating brief: <issue and summary>",
        "- Trigger: <why this is escalating>",
        "- Findings: <what you learned>",
        "- Attempted approaches: <what was tried and why each failed>",
        "- Changed files: <paths touched so far>",
        "- CI output: <failing workflow, run id, head and observed failure, or none and why>",
        "- Unresolved question: <what the next worker still needs to resolve>",
        "",
        "Risk area: <ledger | policy | execution | signer | migration | authz | "
        "authorization | persistence | replay | idempotency | reconciliation> -- "
        "<why this slice starts here>",
    ])

# The whole "## Escalation record" section of the template, verbatim, with every
# field still in its unfilled `<placeholder>` form -- this is what a worker who
# pastes the template without filling it in would actually send.
_RECORD_HEADING_AT = _BRIEF_TEMPLATE_TEXT.index("## Escalation record (escalation spawns only)")
FULL_TEMPLATE_ESCALATION_SECTION = _BRIEF_TEMPLATE_TEXT[_RECORD_HEADING_AT:]

# Everything above that section: the brief's ordinary instructions, which the
# placeholder rule has to leave alone.
TEMPLATE_BODY_ABOVE_RECORD = _BRIEF_TEMPLATE_TEXT[:_RECORD_HEADING_AT]

# Any `<...>` chunk at all, the shape the rule used to match wholesale.
ANY_ANGLE_CHUNK = re.compile(r"<[^<>]*>")

# The template's unfilled Risk area alternative, read from the template so the
# fixture cannot drift from the text a worker actually pastes.
TEMPLATE_RISK_AREA_LINE = next(
    line
    for line in FULL_TEMPLATE_ESCALATION_SECTION.splitlines()
    if line.startswith("Risk area:")
)

# The template's Risk area line with only the category chosen and the reason left
# as template prose: the half-edited shape a parent produces by deleting the
# alternatives -- `Risk area: migration -- <why>.` -- and the one the gate used to
# read as filled because a word survived the placeholder strip.
PARTIAL_RISK_AREA_LINE, _PARTIAL_RISK_AREA_SUBS = re.subn(
    r"<ledger[^>]*>", "migration", TEMPLATE_RISK_AREA_LINE
)

# A slice that starts on escalation: the parent pasted the template section and
# filled only the Risk area alternative, leaving the seven handoff placeholders --
# which describe a failed attempt that never happened -- above it.
RISK_AREA_WITH_UNFILLED_HANDOFF_PROMPT, _RISK_AREA_SUBS = re.subn(
    r"(?m)^Risk area:.*$",
    "Risk area: ledger -- this slice rewrites the journal's posting order.",
    FULL_TEMPLATE_ESCALATION_SECTION,
)

# A complete record under the template's own heading, bullet-prefixed.
TEMPLATE_HEADING_FILLED_PROMPT = "\n".join([
    "## Escalation record (escalation spawns only)",
    "",
    "- Originating brief: #999 -- do a bounded thing.",
    "- Trigger: the second attempt hit the same race as the first.",
    "- Findings: the guard runs after the read, so concurrent writers still interleave.",
    "- Attempted approaches: a service-layer guard, then a unique index; both missed inserts.",
    "- Changed files: packages/ledger/src/journal.ts.",
    "- CI output: none -- the branch was never pushed, so no run exists.",
    "- Unresolved question: whether the lock belongs in the repo or the service.",
])

FILLED_ESCALATION_PROMPT = "\n".join([
    "Escalation:",
    "- Originating brief: #999, the ledger posting-order slice.",
    "- Trigger: the second fix attempt hit the same race as the first.",
    "- Findings: the backfill default is safe for existing rows but not concurrent writers.",
    "- Attempted approaches: a service-layer guard, then a DB constraint; both missed concurrent inserts.",
    "- Changed files: packages/ledger/src/journal.ts, drizzle/0134_journal.sql.",
    "- CI output: verify run 34639284299 failed at db:migrate on a8da4b87.",
    "- Unresolved question: whether the lock belongs in the repo or the service.",
])

# The template's own Trigger line, for a record whose writer filled every field
# but that one.
TEMPLATE_TRIGGER_LINE = next(
    line
    for line in FULL_TEMPLATE_ESCALATION_SECTION.splitlines()
    if line.startswith("- Trigger:")
)

# Six fields filled and the seventh still the template's own line: the record a
# writer produces by working down the template and skipping one field.
LEFTOVER_TRIGGER_PROMPT, _LEFTOVER_TRIGGER_SUBS = re.subn(
    r"(?m)^- Trigger:.*$", TEMPLATE_TRIGGER_LINE, FILLED_ESCALATION_PROMPT
)

# A field whose value continues as an indented block below its label, the way a
# parent writes a record with more than one finding.
MULTILINE_FIELD_ESCALATION_PROMPT = "\n".join([
    "## Escalation record",
    "",
    "- Originating brief: #999 -- do a bounded thing.",
    "- Trigger: the second correction round failed the same way as the first.",
    "- Findings:",
    "  1. the guard runs after the read, so concurrent writers interleave.",
    "  2. the unique index only fires once the second insert lands.",
    "- Attempted approaches:",
    "  (a) a service-layer guard; (b) a unique index. Both missed concurrent inserts.",
    "- Changed files: packages/ledger/src/journal.ts, drizzle/0134_journal.sql.",
    "- CI output: verify run 34639284299 failed at the integration suite.",
    "- Unresolved question: whether the lock belongs in the repo or the service.",
])

# Real field values that quote the docs' own `<worktree>/...` paths: a path root
# has the template's own placeholder shape, so it is stripped before the check --
# it names a real file this slice touched, not prose the writer failed to replace.
ANGLE_BRACKET_VALUE_PROMPT = "\n".join([
    "Escalation:",
    "- Originating brief: #999 -- do a bounded thing.",
    "- Trigger: the builder's second attempt failed the same way as the first.",
    "- Findings: the hook resolves <worktree>/.claude/hooks/agent_policy.py, not the symlink.",
    "- Attempted approaches: a relative path, then a resolved one; both broke under the symlink.",
    "- Changed files: <worktree>/.claude/hooks/agent_policy.py.",
    "- CI output: none -- no CI job selects the hook fixtures.",
    "- Unresolved question: whether the hook should resolve symlinks at all.",
])

# Real field values carrying the angle brackets that ordinary evidence uses: a
# Markdown autolink to the issue, a JSX tag, and a TypeScript generic. None of
# them is the template's placeholder shape, so none of them may unfill a record.
CODE_AND_AUTOLINK_VALUE_PROMPT = "\n".join([
    "Escalation:",
    "- Originating brief: <https://github.com/ceponatia/vigil/issues/560>.",
    "- Trigger: the builder's second attempt failed the same way as the first.",
    "- Findings: <PositionTable /> reads the id as Record<string, Money>, so the cast drops it.",
    "- Attempted approaches: widening the generic, then a cast at the call site; both lost the id.",
    "- Changed files: apps/control/src/components/position-table.tsx.",
    "- CI output: typecheck failed on <https://github.com/ceponatia/vigil/actions/runs/34639284299>.",
    "- Unresolved question: whether the id belongs in the props type at all.",
])

# Route B with the category chosen and nothing else -- the template's placeholder
# deleted rather than answered. A category names no risk the next worker could
# not read off the branch, and on this route that one line is the whole record.
BARE_CATEGORY_RISK_AREA_PROMPT = "Risk area: migration"
NONE_RISK_AREA_PROMPT = "Risk area: none"

# `Findings:` with nothing after it and the next field immediately below.
EMPTY_FIELD_ESCALATION_PROMPT = "\n".join([
    "## Escalation record",
    "",
    "- Originating brief: #999 -- do a bounded thing.",
    "- Trigger: the second attempt failed the same way as the first.",
    "- Findings:",
    "- Attempted approaches: a service-layer guard, then a unique index.",
    "- Changed files: packages/ledger/src/journal.ts.",
    "- CI output: verify run 34639284299 failed at the integration suite.",
    "- Unresolved question: whether the lock belongs in the repo or the service.",
])

# `Findings:` with nothing after it and unindented prose below: prose that is not
# part of the field must not count as its value.
PROSE_AFTER_EMPTY_FIELD_PROMPT = "\n".join([
    "Escalation:",
    "- Originating brief: #999 -- do a bounded thing.",
    "- Trigger: the second attempt failed the same way as the first.",
    "- Findings:",
    "Take over and work out what is going on.",
    "- Attempted approaches: a service-layer guard, then a unique index.",
    "- Changed files: packages/ledger/src/journal.ts.",
    "- CI output: verify run 34639284299 failed at the integration suite.",
    "- Unresolved question: whether the lock belongs in the repo or the service.",
])

# Labels as a parent actually writes them: Markdown emphasis, and a field name that
# carries the writer's own trailing words.
PARAPHRASED_LABEL_ESCALATION_PROMPT = "\n".join([
    "## Escalation record",
    "",
    "- **Originating brief**: #999 -- do a bounded thing.",
    "- **Trigger**: the second attempt failed the same way as the first.",
    "- **Findings**: the guard runs after the read, so concurrent writers interleave.",
    "- Attempted approaches so far: a service-layer guard, then a unique index.",
    "- Changed files so far: packages/ledger/src/journal.ts.",
    "- **CI output**: verify run 34639284299 failed at the integration suite.",
    "- **Unresolved question**: whether the lock belongs in the repo or the service.",
])

# Seven filled fields, but nothing says this is an escalation record.
MARKERLESS_RECORD_PROMPT = "\n".join([
    "- Originating brief: #999 -- do a bounded thing.",
    "- Trigger: the second attempt failed the same way as the first.",
    "- Findings: the guard runs after the read, so concurrent writers interleave.",
    "- Attempted approaches: a service-layer guard, then a unique index.",
    "- Changed files: packages/ledger/src/journal.ts.",
    "- CI output: verify run 34639284299 failed at the integration suite.",
    "- Unresolved question: whether the lock belongs in the repo or the service.",
])

# The record as it read before `CI output` joined it: six filled fields and no
# seventh. `AGENTS.md` escalates over CI contradicting the builder's model, so a
# record that stops at the unresolved question sends the next worker to
# reconstruct the very failure it was escalated over.
SIX_FIELD_RECORD_PROMPT = "\n".join([
    "Escalation:",
    "- Originating brief: #999 -- do a bounded thing.",
    "- Trigger: the second attempt failed the same way as the first.",
    "- Findings: the guard runs after the read, so concurrent writers interleave.",
    "- Attempted approaches: a service-layer guard, then a unique index.",
    "- Changed files: packages/ledger/src/journal.ts.",
    "- Unresolved question: whether the lock belongs in the repo or the service.",
])

# The seventh field answered with `none` and the reason there is none. A slice
# whose change was never pushed has no run to report, and a rule that demanded a
# run id would deny the record for telling the truth -- so `none` with a reason
# is content, and only an empty field or leftover template prose is not.
CI_OUTPUT_NONE_PROMPT = "\n".join([
    "Escalation:",
    "- Originating brief: #999 -- do a bounded thing.",
    "- Trigger: the second attempt failed the same way as the first.",
    "- Findings: the guard runs after the read, so concurrent writers interleave.",
    "- Attempted approaches: a service-layer guard, then a unique index.",
    "- Changed files: packages/ledger/src/journal.ts.",
    "- CI output: none -- no run exists for this uncommitted change.",
    "- Unresolved question: whether the lock belongs in the repo or the service.",
])

FILLED_RISK_AREA_PROMPT = "Risk area: migration -- 0134 renames a column on a hot table."

# Route B with a reason its writer finds convincing and a category the policy does
# not list. Careful work is not the test -- every slice's author thinks theirs is
# careful -- so this is the shape that let any ordinary slice pick the Opus role.
OFF_POLICY_RISK_AREA_PROMPT = "Risk area: styling -- this button needs careful visual polish."

# One line per approved area, spelled the way a writer actually spells it rather
# than the way the constant does: plural, the pairing plus a noun, and the area
# followed by the writer's own words.
APPROVED_RISK_AREA_PROMPTS = (
    "Risk area: ledger -- this slice rewrites the journal's posting order.",
    "Risk area: ledger holdings drift -- reconciliation posts through the wrong state.",
    "Risk area: policy -- the exposure check reads a stale budget snapshot.",
    "Risk area: execution -- the outbox can replay an already-acked order.",
    "Risk area: signer -- the signing request never binds the payload to the approved intent.",
    "Risk area: migrations -- 0134 renames a column on a hot table.",
    "Risk area: authz -- the new route needs an owner check, not a bare session check.",
    "Risk area: authorization -- the new route needs an owner check.",
    "Risk area: persistence/replay correctness -- event replay drops the last fill.",
    "Risk area: replay -- replay drops the last fill event on resume.",
    "Risk area: idempotency -- retries could double-spend the same approved intent.",
    "Risk area: reconciliation -- the nightly reconcile job double-counts a fill.",
)

# The assignment a parent types instead of pasting the template: no marker
# anywhere, but it names a file in this repository and asks for a commit.
FREE_FORM_ASSIGNMENT_PROMPT = "Implement #560; edit .claude/hooks/agent_policy.py and commit the fix"
# The same shape of prompt with no build verb: reading a file is what the
# unpinned and read-only types are for.
RESEARCH_PROMPT = "Summarize the design of apps/trading/src/engine/market-state.ts"
# An instruction to commit, and nothing else.
COMMIT_ONLY_PROMPT = "git commit the fix"
# A build verb naming no file and asking for no commit: the heuristic's
# documented blind spot.
PATHLESS_ASSIGNMENT_PROMPTS = ("fix the wording", "update the docs")

# Research prompts whose ordinary English happens to carry a build verb as a
# noun, next to the very path they are asking about. Both are real prompts a
# parent typed, and both were denied while the verb rule read any position --
# which is the ordinary reason to spawn `general-purpose` at all.
NOUN_VERB_RESEARCH_PROMPTS = (
    "Find where the reconciliation repair is implemented in "
    "apps/trading/src/engine/reconciliation-repair.ts and summarize the write path.",
    "Give me an update on what changed in docs/testing.md this week.",
)
# The same words in imperative position, where they really do assign the work:
# after a discourse cue, and as a list item.
IMPERATIVE_ASSIGNMENT_PROMPTS = (
    "Then update docs/testing.md.",
    "- add a fixture to .claude/hooks/test_agent_policy.py",
)

# The most ordinary review assignment there is, and the one the commit rule used
# to deny: `commit` and `changes` land in the same sentence because that is what
# a prompt about a commit says.
COMMIT_RESEARCH_PROMPT = "Review the changes in commit 2248b048 and summarize them"
# The spellings that do tell a worker to commit: the word after a discourse cue,
# at the head of a sentence, the git command in either of those positions, and
# the brief template's own phrase -- an instruction wherever it sits, since no
# prose says it.
COMMIT_INSTRUCTION_PROMPTS = (
    "and commit the fix",
    "Then commit.",
    "git commit -m 'wip'",
    "Then git commit -m 'wip'",
    "The rule here is to commit by pathspec",
)

# Research about the command itself, which the command rule used to deny wherever
# it appeared: a prompt asking why a command is forbidden is exactly the prompt
# that spells the command out.
GIT_COMMAND_RESEARCH_PROMPTS = (
    "Explain why git commit -a is forbidden in AGENTS.md",
    "`git commit -m x` is forbidden by AGENTS.md",
)

# Imperative assignments the verb list missed. `Change <file> to ...` is how a
# parent most often types one by hand.
VERB_GAP_ASSIGNMENT_PROMPTS = (
    "Change .claude/hooks/agent_policy.py to recognize this instruction",
    "Replace the regex in .claude/hooks/agent_policy.py",
)
# ...and ones naming a file this repository keeps with no extension at all, which
# a dotted-extension rule read as ordinary words.
EXTENSIONLESS_FILE_ASSIGNMENT_PROMPTS = (
    "Update Dockerfile to copy the new package manifest",
    "Then add a rule to .gitignore",
)
# The same filenames with the path a parent actually types. `REPO_PATH` wants an
# extension and these have none, so the most exact spelling of the file was the
# one the rule missed: this repository really does hold `.github/CODEOWNERS`.
PATH_QUALIFIED_FILE_ASSIGNMENT_PROMPTS = (
    "Update .github/CODEOWNERS to add the new package owner",
    "Update ./Dockerfile to copy the new package manifest",
    "Then add a rule to apps/trading/.gitignore",
)

# Research whose build verb is the second half of a coordinated noun phrase.
# `and` joins nouns as readily as clauses, so `delete paths` and `create
# endpoint` satisfied the cue rule while modifying a noun -- and a prompt
# comparing two code paths is exactly the prompt that names the file, which is
# the other half of the rule.
COORDINATED_NOUN_RESEARCH_PROMPTS = (
    "Compare the create and delete paths in apps/trading/src/foo.ts",
    "trace the add flow and create endpoint in apps/trading/src/foo.ts",
)

# The same cue with a real object after the verb: what an instruction has and a
# coordinated noun does not.
CUE_LED_ASSIGNMENT_PROMPTS = (
    "Read the brief and update the hook in .claude/hooks/agent_policy.py",
    "then add a fixture to .claude/hooks/test_agent_policy.py",
)

# The prose those filenames are made of, which must stay prose: `the license` in
# a sentence is not the `LICENSE` file.
KNOWN_FILE_PROSE_PROMPTS = (
    "Update the license section of the readme",
    "Summarize the license this repository ships under",
)

# Route B categories that name an approved area only to say it does not apply.
# Each carries a real rationale and clears every other check, so the category
# rule is the only thing between them and the Opus role.
NEGATED_RISK_AREA_PROMPTS = (
    (
        "Risk area: non-authorization -- this button needs careful visual polish.",
        "non-authorization",
    ),
    (
        "Risk area: unrelated to migration -- this button needs careful visual polish.",
        "unrelated to migration",
    ),
    (
        "Risk area: not a signer change -- this button needs careful visual polish.",
        "not a signer change",
    ),
)


def role_frontmatter(path: Path) -> dict:
    """Read a role file's YAML frontmatter without a YAML dependency: flat `key: value` lines."""
    lines = path.read_text(encoding="utf-8").splitlines()
    if not lines or lines[0].strip() != "---":
        return {}
    fields = {}
    for line in lines[1:]:
        if line.strip() == "---":
            break
        key, sep, value = line.partition(":")
        if sep and key == key.strip():
            fields[key] = value.strip()
    return fields


def run(payload: dict) -> tuple[int, str, str]:
    """Run agent_policy.py as a subprocess with payload on stdin; never execs it."""
    result = subprocess.run(
        [sys.executable, "-B", str(SCRIPT)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
    )
    return result.returncode, result.stdout, result.stderr


class CheckFunctionTests(unittest.TestCase):
    """Exercise check() directly so the pure decision logic is covered without a subprocess."""

    def test_pinned_role_with_explicit_model_is_denied(self):
        reason = HOOK.check({"subagent_type": "vigil-builder", "model": "opus", "prompt": ""})
        self.assertIsNotNone(reason)
        self.assertIn("vigil-builder", reason)

    def test_every_pinned_role_denies_an_explicit_model_and_names_its_own_pin(self):
        """A PINNED role missing from PINNED_MODEL raises here, where the hook itself would
        fail open and silently let the override through."""
        for role in sorted(HOOK.PINNED):
            with self.subTest(role=role):
                reason = HOOK.check({"subagent_type": role, "model": "haiku", "prompt": ""})
                self.assertIsNotNone(reason)
                self.assertIn(role, reason)
                self.assertIn(f"({HOOK.PINNED_MODEL[role]})", reason)

    def test_explicit_model_on_an_unpinned_role_is_allowed(self):
        """The deny message sends ad-hoc work to `general-purpose` with a model; keep that route open."""
        reason = HOOK.check(
            {"subagent_type": "general-purpose", "model": "opus", "prompt": "look into the flaky test"}
        )
        self.assertIsNone(reason)

    def test_pinned_role_without_model_and_with_brief_is_allowed(self):
        reason = HOOK.check({"subagent_type": "vigil-builder", "prompt": BRIEF_PROMPT})
        self.assertIsNone(reason)

    def test_escalation_without_record_is_denied_and_offers_both_routes(self):
        reason = HOOK.check({"subagent_type": "vigil-escalation", "prompt": "take over please"})
        self.assertIsNotNone(reason)
        self.assertIn("Route A", reason)
        self.assertIn("Route B", reason)
        for field in HOOK.RECORD_FIELDS:
            with self.subTest(field=field):
                self.assertIn(field, reason)

    def test_escalation_with_escalation_line_is_allowed(self):
        reason = HOOK.check({"subagent_type": "vigil-escalation", "prompt": ESCALATION_PROMPT})
        self.assertIsNone(reason)

    def test_escalation_with_risk_area_line_is_allowed(self):
        reason = HOOK.check({"subagent_type": "vigil-escalation", "prompt": RISK_AREA_PROMPT})
        self.assertIsNone(reason)

    def test_escalation_record_below_an_opening_line_is_allowed(self):
        reason = HOOK.check(
            {"subagent_type": "vigil-escalation", "prompt": LATE_ESCALATION_PROMPT}
        )
        self.assertIsNone(reason)

    def test_escalation_with_the_brief_template_heading_and_seven_filled_fields_is_allowed(self):
        reason = HOOK.check(
            {"subagent_type": "vigil-escalation", "prompt": TEMPLATE_HEADING_FILLED_PROMPT}
        )
        self.assertIsNone(reason)

    def test_escalation_with_only_the_record_heading_is_denied_and_names_every_field(self):
        """A heading is a label, not a record: the worker would start with no findings, no
        attempted approaches, no changed files and no question -- exactly what it needs."""
        reason = HOOK.check({"subagent_type": "vigil-escalation", "prompt": HEADING_ONLY_PROMPT})
        self.assertIsNotNone(reason)
        for field in HOOK.RECORD_FIELDS:
            with self.subTest(field=field):
                self.assertIn(field, reason)

    def test_escalation_with_a_two_field_record_is_denied_and_names_the_missing_ones(self):
        """Deleting the fields you cannot fill must not pass: the deny reason names the five
        that are gone and stays silent about the two that are there."""
        reason = HOOK.check(
            {"subagent_type": "vigil-escalation", "prompt": PARTIAL_ESCALATION_PROMPT}
        )
        self.assertIsNotNone(reason)
        route_a = next(line for line in reason.splitlines() if line.startswith("Route A"))
        for field in (
            "Findings",
            "Attempted approaches",
            "Changed files",
            "CI output",
            "Unresolved question",
        ):
            with self.subTest(field=field):
                self.assertIn(field, route_a)
        self.assertNotIn("Originating brief", route_a)
        self.assertNotIn("Trigger", route_a)

    def test_escalation_with_the_unfilled_template_section_is_denied_as_boilerplate(self):
        """Pasting the whole template section without filling it in must not satisfy the
        gate: every field is still `<placeholder>` text, not this slice's facts."""
        reason = HOOK.check(
            {"subagent_type": "vigil-escalation", "prompt": FULL_TEMPLATE_ESCALATION_SECTION}
        )
        self.assertIsNotNone(reason)
        self.assertIn("placeholder", reason.lower())
        for field in HOOK.RECORD_FIELDS:
            with self.subTest(field=field):
                self.assertIn(field, reason)

    def test_escalation_with_a_filled_record_is_allowed(self):
        reason = HOOK.check(
            {"subagent_type": "vigil-escalation", "prompt": FILLED_ESCALATION_PROMPT}
        )
        self.assertIsNone(reason)

    def test_escalation_without_the_ci_output_field_is_denied_and_names_it(self):
        """`AGENTS.md` escalates over CI contradicting the builder's model, so the record has
        to carry what CI actually said. A six-field record is complete by every other measure
        -- marked, filled, no placeholders -- which is why the missing field has to be named
        rather than left to a general complaint about the record."""
        reason = HOOK.check(
            {"subagent_type": "vigil-escalation", "prompt": SIX_FIELD_RECORD_PROMPT}
        )
        self.assertIsNotNone(reason)
        route_a = next(line for line in reason.splitlines() if line.startswith("Route A"))
        self.assertIn("missing: CI output", route_a)
        for field in HOOK.RECORD_FIELDS:
            if field == "CI output":
                continue
            with self.subTest(field=field):
                self.assertNotIn(field, route_a)

    def test_escalation_reporting_no_ci_run_with_a_reason_is_allowed(self):
        """The field asks what CI said, not that CI ran. An uncommitted change has no run,
        and denying `none -- no run exists for this uncommitted change` would deny the record
        for being accurate -- which is how a required field turns into a field people fill
        with anything."""
        reason = HOOK.check(
            {"subagent_type": "vigil-escalation", "prompt": CI_OUTPUT_NONE_PROMPT}
        )
        self.assertIsNone(reason)

    def test_escalation_with_a_filled_risk_area_line_naming_a_migration_is_allowed(self):
        reason = HOOK.check(
            {"subagent_type": "vigil-escalation", "prompt": FILLED_RISK_AREA_PROMPT}
        )
        self.assertIsNone(reason)

    def test_filled_risk_area_above_the_unfilled_handoff_placeholders_is_allowed(self):
        """A slice that starts on escalation fills the template's Risk area alternative and
        leaves the handoff fields unfilled -- there is no failed attempt to report. The
        documented direct-escalation route has to work with the standard template."""
        reason = HOOK.check(
            {
                "subagent_type": "vigil-escalation",
                "prompt": RISK_AREA_WITH_UNFILLED_HANDOFF_PROMPT,
            }
        )
        self.assertIsNone(reason)

    def test_escalation_with_only_the_template_risk_area_line_is_denied(self):
        """The alternative pasted but not filled in names no risk at all."""
        reason = HOOK.check(
            {"subagent_type": "vigil-escalation", "prompt": TEMPLATE_RISK_AREA_LINE}
        )
        self.assertIsNotNone(reason)
        self.assertIn("Risk area", reason)

    def test_escalation_with_a_half_edited_risk_area_line_is_denied(self):
        """Choosing the category and leaving `<why>` gives the worker no reason at all. A
        leftover placeholder must not be rescued by the words around it, or every partially
        edited template line satisfies the gate."""
        reason = HOOK.check(
            {"subagent_type": "vigil-escalation", "prompt": PARTIAL_RISK_AREA_LINE}
        )
        self.assertIsNotNone(reason)
        route_b = next(line for line in reason.splitlines() if line.startswith("Route B"))
        self.assertIn("present but unfilled", route_b)

    def test_escalation_with_one_field_left_as_template_text_is_denied_and_names_only_it(self):
        """Six filled fields do not carry the seventh: the deny reason names the field still
        holding the template's prose and stays silent about the six that are done."""
        reason = HOOK.check(
            {"subagent_type": "vigil-escalation", "prompt": LEFTOVER_TRIGGER_PROMPT}
        )
        self.assertIsNotNone(reason)
        route_a = next(line for line in reason.splitlines() if line.startswith("Route A"))
        self.assertIn("Trigger", route_a)
        self.assertNotIn("missing", route_a)
        for field in HOOK.RECORD_FIELDS:
            if field == "Trigger":
                continue
            with self.subTest(field=field):
                self.assertNotIn(field, route_a)

    def test_escalation_with_an_indented_multiline_field_is_allowed(self):
        """A field whose value is a list below its label is filled in; requiring the value on
        the label's own line would deny real records."""
        reason = HOOK.check(
            {"subagent_type": "vigil-escalation", "prompt": MULTILINE_FIELD_ESCALATION_PROMPT}
        )
        self.assertIsNone(reason)

    def test_escalation_field_quoting_a_placeholder_path_is_allowed(self):
        """`<worktree>/...` is a real path this slice touched, not template boilerplate: a
        bracketed token followed immediately by `/` names a path root, and reading it as
        template prose would deny real records about paths."""
        reason = HOOK.check(
            {"subagent_type": "vigil-escalation", "prompt": ANGLE_BRACKET_VALUE_PROMPT}
        )
        self.assertIsNone(reason)

    def test_escalation_field_carrying_an_autolink_jsx_or_a_generic_is_allowed(self):
        """Real evidence uses angle brackets: `<https://.../issues/560>` is the issue link the
        record is supposed to carry, `<PositionTable />` and `Record<string, Money>` are the
        code the finding is about. Reading any of them as leftover template prose would deny
        the very records this gate exists to require."""
        reason = HOOK.check(
            {"subagent_type": "vigil-escalation", "prompt": CODE_AND_AUTOLINK_VALUE_PROMPT}
        )
        self.assertIsNone(reason)

    def test_escalation_with_a_bare_risk_area_category_is_denied_for_the_missing_rationale(self):
        """`Risk area: migration` deletes the placeholder instead of answering it. The line is
        the entire record on this route, so a category with no reason must not open it -- and
        the deny reason has to say that, not repeat the placeholder complaint."""
        for prompt in (BARE_CATEGORY_RISK_AREA_PROMPT, NONE_RISK_AREA_PROMPT):
            with self.subTest(prompt=prompt):
                reason = HOOK.check({"subagent_type": "vigil-escalation", "prompt": prompt})
                self.assertIsNotNone(reason)
                route_b = next(
                    line for line in reason.splitlines() if line.startswith("Route B")
                )
                self.assertIn("without a rationale", route_b)
                self.assertNotIn("present but unfilled", route_b)
                self.assertIn("Risk area: migration — 0134 rewrites a hot table", route_b)

    def test_escalation_with_a_risk_area_outside_the_approved_list_is_denied(self):
        """A rationale is not a risk area. `AGENTS.md` limits a direct start to the ledger,
        policy, execution, signer, migration, authorization, persistence, replay, idempotency,
        and reconciliation risk areas, so a convincing sentence about styling must not open
        the Opus role -- and the deny reason has to name the area it refused, list the ones it
        takes, and send the slice to the builder, not repeat the rationale or placeholder
        complaints."""
        reason = HOOK.check(
            {"subagent_type": "vigil-escalation", "prompt": OFF_POLICY_RISK_AREA_PROMPT}
        )
        self.assertIsNotNone(reason)
        route_b = next(line for line in reason.splitlines() if line.startswith("Route B"))
        self.assertIn("styling", route_b)
        self.assertIn("vigil-builder", route_b)
        for area in HOOK.RISK_AREAS:
            with self.subTest(area=area):
                self.assertIn(f"`{area}`", route_b)
        self.assertNotIn("without a rationale", route_b)
        self.assertNotIn("present but unfilled", route_b)

    def test_escalation_with_a_negated_risk_area_is_denied(self):
        """`non-authorization` and `unrelated to migration` carry an approved word inside a
        category that says the opposite, and everything else about the line is well formed.
        Looking for the word anywhere in the category opened the Opus role on the very
        negation, so the category has to lead with the area rather than contain it."""
        for prompt, named in NEGATED_RISK_AREA_PROMPTS:
            with self.subTest(prompt=prompt):
                reason = HOOK.check({"subagent_type": "vigil-escalation", "prompt": prompt})
                self.assertIsNotNone(reason)
                route_b = next(
                    line for line in reason.splitlines() if line.startswith("Route B")
                )
                self.assertIn(named, route_b)
                self.assertIn("not one of the areas", route_b)
                self.assertIn("vigil-builder", route_b)
                self.assertNotIn("without a rationale", route_b)
                self.assertNotIn("present but unfilled", route_b)

    def test_escalation_with_an_approved_risk_area_is_allowed_however_it_is_spelled(self):
        """The gate reads the category, not the constant: a plural, and the
        `persistence/replay` pairing with a noun after it are how writers actually name
        these areas, and denying them would push real escalation slices onto the
        builder."""
        for prompt in APPROVED_RISK_AREA_PROMPTS:
            with self.subTest(prompt=prompt):
                reason = HOOK.check({"subagent_type": "vigil-escalation", "prompt": prompt})
                self.assertIsNone(reason)

    def test_every_approved_area_opens_the_route_under_its_own_name(self):
        """An entry in the list that no spelling reaches is a direct-start route the policy
        documents and the hook silently refuses."""
        for area in HOOK.RISK_AREAS:
            with self.subTest(area=area):
                reason = HOOK.check({
                    "subagent_type": "vigil-escalation",
                    "prompt": f"Risk area: {area} -- this slice changes behaviour tests cannot see.",
                })
                self.assertIsNone(reason)

    def test_kernel_and_simulation_core_are_no_longer_approved_risk_areas(self):
        """`kernel` and `simulation-core` belonged to the reference workflow's risk-area list,
        not this repository's: this repository has no kernel or simulation engine at all, so a
        slice naming either as its Risk area still starts on `vigil-builder`, the same as any
        other category the policy does not list."""
        self.assertNotIn("kernel", HOOK.RISK_AREAS)
        self.assertNotIn("simulation-core", HOOK.RISK_AREAS)
        for prompt in (
            "Risk area: kernel -- this slice rewrites the journal's posting order.",
            "Risk area: simulation-core -- this slice rewrites the journal's posting order.",
        ):
            with self.subTest(prompt=prompt):
                reason = HOOK.check({"subagent_type": "vigil-escalation", "prompt": prompt})
                self.assertIsNotNone(reason)
                route_b = next(line for line in reason.splitlines() if line.startswith("Route B"))
                self.assertIn("not one of the areas", route_b)
                self.assertIn("vigil-builder", route_b)

    def test_idempotency_and_reconciliation_open_the_escalation_route(self):
        """Two risk areas this repository's financial-authority rules add beyond the reference
        workflow's list: a retried approval and a reconciliation drift both start on
        `vigil-escalation` directly, the same as a migration or a signer change."""
        for prompt in (
            "Risk area: idempotency -- retries could double-spend the same approved intent.",
            "Risk area: reconciliation -- the nightly reconcile job double-counts a fill.",
        ):
            with self.subTest(prompt=prompt):
                reason = HOOK.check({"subagent_type": "vigil-escalation", "prompt": prompt})
                self.assertIsNone(reason)

    def test_escalation_with_an_empty_field_is_denied_and_names_it(self):
        reason = HOOK.check(
            {"subagent_type": "vigil-escalation", "prompt": EMPTY_FIELD_ESCALATION_PROMPT}
        )
        self.assertIsNotNone(reason)
        self.assertIn("Findings", reason)
        self.assertNotIn("Changed files", reason.split("Route B")[0])

    def test_escalation_with_unindented_prose_after_an_empty_field_is_denied(self):
        """Only an indented block continues a field; the next unindented line belongs to the
        prompt, not to `Findings:`."""
        reason = HOOK.check(
            {"subagent_type": "vigil-escalation", "prompt": PROSE_AFTER_EMPTY_FIELD_PROMPT}
        )
        self.assertIsNotNone(reason)
        self.assertIn("Findings", reason)

    def test_escalation_with_paraphrased_field_labels_is_allowed(self):
        """The gate reads the record's content, not its typography: bold labels and a field
        name with trailing words (`Changed files so far:`) still name the same field."""
        reason = HOOK.check(
            {"subagent_type": "vigil-escalation", "prompt": PARAPHRASED_LABEL_ESCALATION_PROMPT}
        )
        self.assertIsNone(reason)

    def test_escalation_with_seven_filled_fields_but_no_marker_is_denied_for_the_marker(self):
        """Seven filled fields loose in a prompt are not yet a record the role can find: the
        deny reason asks for the marker and reports no missing field."""
        reason = HOOK.check(
            {"subagent_type": "vigil-escalation", "prompt": MARKERLESS_RECORD_PROMPT}
        )
        self.assertIsNotNone(reason)
        route_a = next(line for line in reason.splitlines() if line.startswith("Route A"))
        self.assertIn("`Escalation:` line or `## Escalation` heading", route_a)
        self.assertNotIn("missing", route_a)

    def test_brief_sent_to_unpinned_role_is_denied_and_names_vigil_builder(self):
        reason = HOOK.check({"subagent_type": "general-purpose", "prompt": BRIEF_PROMPT})
        self.assertIsNotNone(reason)
        self.assertIn("vigil-builder", reason)

    def test_brief_with_missing_subagent_type_is_denied(self):
        reason = HOOK.check({"prompt": BRIEF_PROMPT})
        self.assertIsNotNone(reason)

    def test_plain_prompt_to_unpinned_role_is_allowed(self):
        reason = HOOK.check({"subagent_type": "general-purpose", "prompt": "look into the flaky test"})
        self.assertIsNone(reason)

    def test_free_form_assignment_to_an_unpinned_role_is_denied_and_names_vigil_builder(self):
        """The missed-instructions case the gate exists for: a parent who never opened the
        template still assigns implementation work, and a marker-only detector waves it
        through to whatever model the ad-hoc default happens to be."""
        reason = HOOK.check(
            {"subagent_type": "general-purpose", "prompt": FREE_FORM_ASSIGNMENT_PROMPT}
        )
        self.assertIsNotNone(reason)
        self.assertIn("vigil-builder", reason)

    def test_a_commit_instruction_alone_to_an_unpinned_role_is_denied(self):
        """Nothing read-only commits."""
        reason = HOOK.check({"subagent_type": "general-purpose", "prompt": COMMIT_ONLY_PROMPT})
        self.assertIsNotNone(reason)
        self.assertIn("vigil-builder", reason)

    def test_a_research_prompt_naming_a_file_is_allowed(self):
        """A path is not an assignment. Denying every prompt that names a file would deny the
        ordinary reason to spawn `general-purpose` at all, and a gate that denies ordinary
        prompts gets worked around rather than followed."""
        reason = HOOK.check({"subagent_type": "general-purpose", "prompt": RESEARCH_PROMPT})
        self.assertIsNone(reason)

    def test_a_build_verb_used_as_a_noun_beside_a_path_is_allowed(self):
        """A research prompt about code names files; `the write path` and `an update on`
        are the same words the build rule looks for, used as nouns. Reading the verb in
        any position denied both of these, and denying research on a named file is
        exactly the gate-gets-worked-around failure the rule is shaped to avoid."""
        for prompt in NOUN_VERB_RESEARCH_PROMPTS:
            with self.subTest(prompt=prompt):
                reason = HOOK.check({"subagent_type": "general-purpose", "prompt": prompt})
                self.assertIsNone(reason)

    def test_a_build_verb_in_imperative_position_beside_a_path_is_denied(self):
        """The other half of the same rule: position is what separates the noun from the
        instruction, so a verb after a discourse cue or at the head of a list item still
        assigns the work even with no template text and no commit instruction."""
        for prompt in IMPERATIVE_ASSIGNMENT_PROMPTS:
            with self.subTest(prompt=prompt):
                reason = HOOK.check({"subagent_type": "general-purpose", "prompt": prompt})
                self.assertIsNotNone(reason)
                self.assertIn("vigil-builder", reason)

    def test_a_prompt_reviewing_a_commit_is_allowed(self):
        """`commit` is a noun in review prose, and a prompt about a commit is exactly the
        prompt that also says `changes` -- so reading the two in one sentence as an
        instruction denied the most ordinary read-only assignment there is."""
        reason = HOOK.check(
            {"subagent_type": "general-purpose", "prompt": COMMIT_RESEARCH_PROMPT}
        )
        self.assertIsNone(reason)

    def test_every_commit_instruction_spelling_is_still_denied(self):
        """The other half of the same move: narrowing the rule to imperative position must
        not drop the signal. A discourse cue, a sentence head, the git command and the
        template's own `commit by pathspec` all still say commit."""
        for prompt in COMMIT_INSTRUCTION_PROMPTS:
            with self.subTest(prompt=prompt):
                reason = HOOK.check({"subagent_type": "general-purpose", "prompt": prompt})
                self.assertIsNotNone(reason)
                self.assertIn("vigil-builder", reason)

    def test_change_and_replace_assign_work_like_the_other_build_verbs(self):
        """They are the same instruction as `edit` or `rewrite`, written the way a parent
        writes it; a verb list missing them let the free-form spawn through to whatever
        model the ad-hoc default happens to be."""
        for prompt in VERB_GAP_ASSIGNMENT_PROMPTS:
            with self.subTest(prompt=prompt):
                reason = HOOK.check({"subagent_type": "general-purpose", "prompt": prompt})
                self.assertIsNotNone(reason)
                self.assertIn("vigil-builder", reason)

    def test_an_assignment_naming_an_extensionless_repository_file_is_denied(self):
        """`Dockerfile` and `.gitignore` are files this repository holds and a worker edits.
        Requiring a dotted extension read them as ordinary words and allowed the
        assignment."""
        for prompt in EXTENSIONLESS_FILE_ASSIGNMENT_PROMPTS:
            with self.subTest(prompt=prompt):
                reason = HOOK.check({"subagent_type": "general-purpose", "prompt": prompt})
                self.assertIsNotNone(reason)
                self.assertIn("vigil-builder", reason)

    def test_a_prose_mention_of_an_extensionless_filename_is_allowed(self):
        """What that rule must not cost: `the license` in a sentence is not the `LICENSE`
        file. Matching those names case-sensitively and as whole tokens is what keeps an
        ordinary sentence from being read as a path."""
        for prompt in KNOWN_FILE_PROSE_PROMPTS:
            with self.subTest(prompt=prompt):
                reason = HOOK.check({"subagent_type": "general-purpose", "prompt": prompt})
                self.assertIsNone(reason)

    def test_an_assignment_naming_a_path_qualified_repository_file_is_denied(self):
        """The spelling the rule missed while it refused a preceding slash: `REPO_PATH` wants
        an extension and `CODEOWNERS` has none, so `Update .github/CODEOWNERS to ...`
        -- the most exact way to name a file this repository holds -- reached an unpinned
        agent."""
        for prompt in PATH_QUALIFIED_FILE_ASSIGNMENT_PROMPTS:
            with self.subTest(prompt=prompt):
                reason = HOOK.check({"subagent_type": "general-purpose", "prompt": prompt})
                self.assertIsNotNone(reason)
                self.assertIn("vigil-builder", reason)

    def test_a_research_prompt_coordinating_a_build_verb_as_a_noun_is_allowed(self):
        """`and` joins noun phrases as readily as clauses: in `the create and delete paths`
        the word after the cue modifies `paths`. Reading every cue-led verb as an instruction
        denied a prompt that only compares two code paths -- and comparing code paths is the
        ordinary reason to spawn `general-purpose` on a named file at all."""
        for prompt in COORDINATED_NOUN_RESEARCH_PROMPTS:
            with self.subTest(prompt=prompt):
                reason = HOOK.check({"subagent_type": "general-purpose", "prompt": prompt})
                self.assertIsNone(reason)

    def test_a_cue_led_verb_with_a_real_object_is_still_denied(self):
        """The other half of that move: narrowing the cue branch must not drop the signal.
        A determiner or a named target after the verb is what an instruction carries and a
        coordinated noun does not."""
        for prompt in CUE_LED_ASSIGNMENT_PROMPTS:
            with self.subTest(prompt=prompt):
                reason = HOOK.check({"subagent_type": "general-purpose", "prompt": prompt})
                self.assertIsNotNone(reason)
                self.assertIn("vigil-builder", reason)

    def test_a_prompt_asking_about_the_git_commit_command_is_allowed(self):
        """`Explain why git commit -a is forbidden in AGENTS.md` is research, and a prompt
        about a forbidden command is exactly the prompt that spells the command out. Reading
        the command as an instruction wherever it appeared denied it, and it also names
        `AGENTS.md`, so the file half of the rule could not save it either."""
        for prompt in GIT_COMMAND_RESEARCH_PROMPTS:
            with self.subTest(prompt=prompt):
                reason = HOOK.check({"subagent_type": "general-purpose", "prompt": prompt})
                self.assertIsNone(reason)

    def test_an_assignment_naming_no_file_and_no_commit_is_allowed_by_design(self):
        """The heuristic's documented limit, asserted so it stays a decision rather than a
        surprise: `fix the wording` is indistinguishable from ordinary prose, and the only
        rule wide enough to catch it denies most real prompts."""
        for prompt in PATHLESS_ASSIGNMENT_PROMPTS:
            with self.subTest(prompt=prompt):
                reason = HOOK.check({"subagent_type": "general-purpose", "prompt": prompt})
                self.assertIsNone(reason)

    def test_read_only_agent_types_take_an_assignment_shaped_prompt(self):
        """Explore and Plan hold no edit or commit tools, so a brief-shaped prompt to one of
        them is research. Denying it would leave no way to ask them to look at the work a
        brief describes -- which is the reason to spawn them."""
        for agent_type in sorted(HOOK.READ_ONLY_TYPES):
            for prompt in (FREE_FORM_ASSIGNMENT_PROMPT, BRIEF_PROMPT, COMMIT_ONLY_PROMPT):
                with self.subTest(agent_type=agent_type, prompt=prompt):
                    reason = HOOK.check({"subagent_type": agent_type, "prompt": prompt})
                    self.assertIsNone(reason)

    def test_no_pinned_role_is_exempt_as_read_only(self):
        """The exemption skips rule 3 entirely; a pinned role landing in it would also lose
        the model-override check's neighbours."""
        self.assertEqual(HOOK.PINNED & HOOK.READ_ONLY_TYPES, set())

    def test_issue_filer_is_pinned_to_sonnet_and_denies_a_model_override(self):
        self.assertIn("vigil-issue-filer", HOOK.PINNED)
        self.assertEqual(HOOK.PINNED_MODEL["vigil-issue-filer"], "sonnet")
        deny = HOOK.check({
            "subagent_type": "vigil-issue-filer",
            "model": "opus",
            "prompt": "File the BOOT-01 issue on the board.",
        })
        self.assertIsNotNone(deny)
        self.assertIn("sonnet", deny)

    def test_an_issue_filing_assignment_naming_a_repo_file_is_allowed_on_the_filer(self):
        # "Create … from docs/product.md" is a build verb in imperative position
        # next to a repository file, so an unpinned role is refused it; the
        # filer is pinned, so the same prompt is its ordinary work.
        prompt = (
            "Create the BOOT-01 through BOOT-03 issues from docs/product.md "
            "and file them on the board with parent #12."
        )
        self.assertIsNone(HOOK.check({"subagent_type": "vigil-issue-filer", "prompt": prompt}))
        self.assertIsNotNone(HOOK.check({"subagent_type": "general-purpose", "prompt": prompt}))

    def test_board_auditor_is_pinned_to_sonnet_and_denies_a_model_override(self):
        self.assertIn("vigil-board-auditor", HOOK.PINNED)
        self.assertEqual(HOOK.PINNED_MODEL["vigil-board-auditor"], "sonnet")
        deny = HOOK.check({
            "subagent_type": "vigil-board-auditor",
            "model": "opus",
            "prompt": "Audit issues #3 through #11 on the board and fill what the filer missed.",
        })
        self.assertIsNotNone(deny)
        self.assertIn("sonnet", deny)

    def test_an_audit_assignment_naming_a_repo_file_is_allowed_on_the_auditor(self):
        # "Update … board.env" is a build verb in imperative position next to a
        # repository file, so an unpinned role is refused it; the auditor is
        # pinned, so a board brief that happens to name a file is its ordinary work.
        prompt = (
            "Audit the batch under parent #3. Update the Horizon field where it is unset "
            "using .agents/skills/vigil-board/board.env for the repository."
        )
        self.assertIsNone(HOOK.check({"subagent_type": "vigil-board-auditor", "prompt": prompt}))
        self.assertIsNotNone(HOOK.check({"subagent_type": "general-purpose", "prompt": prompt}))



class ProcessTests(unittest.TestCase):
    """Exercise the stdin-to-exit-code wiring, matching how Claude Code actually invokes the hook."""

    def test_non_agent_tool_exits_zero_with_no_output(self):
        code, out, err = run({"tool_name": "Bash", "tool_input": {"command": "ls"}})
        self.assertEqual(code, 0)
        self.assertEqual(out, "")
        self.assertEqual(err, "")

    def test_explore_with_plain_prompt_passes(self):
        code, out, err = run({
            "tool_name": "Agent",
            "tool_input": {"subagent_type": "Explore", "prompt": "find the file that defines X"},
        })
        self.assertEqual(code, 0, err)

    def test_general_purpose_with_plain_prompt_passes(self):
        code, out, err = run({
            "tool_name": "Agent",
            "tool_input": {"subagent_type": "general-purpose", "prompt": "look into the flaky test"},
        })
        self.assertEqual(code, 0, err)

    def test_general_purpose_with_brief_is_denied_and_names_vigil_builder(self):
        code, out, err = run({
            "tool_name": "Agent",
            "tool_input": {"subagent_type": "general-purpose", "prompt": BRIEF_PROMPT},
        })
        self.assertEqual(code, 2)
        self.assertIn("vigil-builder", err)

    def test_missing_subagent_type_with_brief_is_denied(self):
        code, out, err = run({"tool_name": "Agent", "tool_input": {"prompt": BRIEF_PROMPT}})
        self.assertEqual(code, 2)

    def test_vigil_builder_with_brief_and_no_model_passes(self):
        code, out, err = run({
            "tool_name": "Agent",
            "tool_input": {"subagent_type": "vigil-builder", "prompt": BRIEF_PROMPT},
        })
        self.assertEqual(code, 0, err)

    def test_vigil_builder_with_explicit_model_is_denied(self):
        code, out, err = run({
            "tool_name": "Agent",
            "tool_input": {"subagent_type": "vigil-builder", "model": "opus", "prompt": BRIEF_PROMPT},
        })
        self.assertEqual(code, 2)

    def test_vigil_escalation_without_record_is_denied(self):
        code, out, err = run({
            "tool_name": "Agent",
            "tool_input": {"subagent_type": "vigil-escalation", "prompt": "take over please"},
        })
        self.assertEqual(code, 2)

    def test_vigil_escalation_with_escalation_line_passes(self):
        code, out, err = run({
            "tool_name": "Agent",
            "tool_input": {"subagent_type": "vigil-escalation", "prompt": ESCALATION_PROMPT},
        })
        self.assertEqual(code, 0, err)

    def test_vigil_escalation_with_a_partial_record_is_denied_naming_the_missing_fields(self):
        code, out, err = run({
            "tool_name": "Agent",
            "tool_input": {
                "subagent_type": "vigil-escalation",
                "prompt": PARTIAL_ESCALATION_PROMPT,
            },
        })
        self.assertEqual(code, 2)
        self.assertIn("Findings", err)
        self.assertIn("Unresolved question", err)

    def test_vigil_escalation_with_risk_area_line_passes(self):
        code, out, err = run({
            "tool_name": "Agent",
            "tool_input": {"subagent_type": "vigil-escalation", "prompt": RISK_AREA_PROMPT},
        })
        self.assertEqual(code, 0, err)

    def test_vigil_escalation_with_a_bare_risk_area_category_is_denied(self):
        code, out, err = run({
            "tool_name": "Agent",
            "tool_input": {
                "subagent_type": "vigil-escalation",
                "prompt": BARE_CATEGORY_RISK_AREA_PROMPT,
            },
        })
        self.assertEqual(code, 2)
        self.assertIn("without a rationale", err)

    def test_vigil_escalation_with_angle_bracket_evidence_passes(self):
        code, out, err = run({
            "tool_name": "Agent",
            "tool_input": {
                "subagent_type": "vigil-escalation",
                "prompt": CODE_AND_AUTOLINK_VALUE_PROMPT,
            },
        })
        self.assertEqual(code, 0, err)

    def test_general_purpose_with_a_free_form_assignment_is_denied(self):
        code, out, err = run({
            "tool_name": "Agent",
            "tool_input": {
                "subagent_type": "general-purpose",
                "prompt": FREE_FORM_ASSIGNMENT_PROMPT,
            },
        })
        self.assertEqual(code, 2)
        self.assertIn("vigil-builder", err)

    def test_general_purpose_with_a_research_prompt_naming_a_path_passes(self):
        for prompt in NOUN_VERB_RESEARCH_PROMPTS:
            with self.subTest(prompt=prompt):
                code, out, err = run({
                    "tool_name": "Agent",
                    "tool_input": {"subagent_type": "general-purpose", "prompt": prompt},
                })
                self.assertEqual(code, 0, err)

    def test_general_purpose_with_an_imperative_assignment_is_denied(self):
        for prompt in IMPERATIVE_ASSIGNMENT_PROMPTS:
            with self.subTest(prompt=prompt):
                code, out, err = run({
                    "tool_name": "Agent",
                    "tool_input": {"subagent_type": "general-purpose", "prompt": prompt},
                })
                self.assertEqual(code, 2)
                self.assertIn("vigil-builder", err)

    def test_general_purpose_reviewing_a_commit_passes(self):
        code, out, err = run({
            "tool_name": "Agent",
            "tool_input": {"subagent_type": "general-purpose", "prompt": COMMIT_RESEARCH_PROMPT},
        })
        self.assertEqual(code, 0, err)

    def test_general_purpose_with_an_extensionless_file_assignment_is_denied(self):
        for prompt in EXTENSIONLESS_FILE_ASSIGNMENT_PROMPTS:
            with self.subTest(prompt=prompt):
                code, out, err = run({
                    "tool_name": "Agent",
                    "tool_input": {"subagent_type": "general-purpose", "prompt": prompt},
                })
                self.assertEqual(code, 2)
                self.assertIn("vigil-builder", err)

    def test_general_purpose_with_a_path_qualified_file_assignment_is_denied(self):
        for prompt in PATH_QUALIFIED_FILE_ASSIGNMENT_PROMPTS:
            with self.subTest(prompt=prompt):
                code, out, err = run({
                    "tool_name": "Agent",
                    "tool_input": {"subagent_type": "general-purpose", "prompt": prompt},
                })
                self.assertEqual(code, 2)
                self.assertIn("vigil-builder", err)

    def test_general_purpose_with_a_coordinated_noun_research_prompt_passes(self):
        for prompt in COORDINATED_NOUN_RESEARCH_PROMPTS + GIT_COMMAND_RESEARCH_PROMPTS:
            with self.subTest(prompt=prompt):
                code, out, err = run({
                    "tool_name": "Agent",
                    "tool_input": {"subagent_type": "general-purpose", "prompt": prompt},
                })
                self.assertEqual(code, 0, err)

    def test_vigil_escalation_without_the_ci_output_field_is_denied(self):
        code, out, err = run({
            "tool_name": "Agent",
            "tool_input": {
                "subagent_type": "vigil-escalation",
                "prompt": SIX_FIELD_RECORD_PROMPT,
            },
        })
        self.assertEqual(code, 2)
        self.assertIn("CI output", err)

    def test_vigil_escalation_reporting_no_ci_run_passes(self):
        code, out, err = run({
            "tool_name": "Agent",
            "tool_input": {"subagent_type": "vigil-escalation", "prompt": CI_OUTPUT_NONE_PROMPT},
        })
        self.assertEqual(code, 0, err)

    def test_explore_with_a_free_form_assignment_passes(self):
        code, out, err = run({
            "tool_name": "Agent",
            "tool_input": {"subagent_type": "Explore", "prompt": FREE_FORM_ASSIGNMENT_PROMPT},
        })
        self.assertEqual(code, 0, err)

    def test_vigil_escalation_with_an_off_policy_risk_area_is_denied(self):
        code, out, err = run({
            "tool_name": "Agent",
            "tool_input": {
                "subagent_type": "vigil-escalation",
                "prompt": OFF_POLICY_RISK_AREA_PROMPT,
            },
        })
        self.assertEqual(code, 2)
        self.assertIn("styling", err)
        self.assertIn("vigil-builder", err)

    def test_vigil_escalation_with_a_negated_risk_area_is_denied(self):
        for prompt, named in NEGATED_RISK_AREA_PROMPTS:
            with self.subTest(prompt=prompt):
                code, out, err = run({
                    "tool_name": "Agent",
                    "tool_input": {"subagent_type": "vigil-escalation", "prompt": prompt},
                })
                self.assertEqual(code, 2)
                self.assertIn(named, err)
                self.assertIn("vigil-builder", err)

    def test_vigil_reviewer_with_brief_passes(self):
        code, out, err = run({
            "tool_name": "Agent",
            "tool_input": {"subagent_type": "vigil-reviewer", "prompt": BRIEF_PROMPT},
        })
        self.assertEqual(code, 0, err)

    def test_vigil_test_keeper_with_brief_passes(self):
        code, out, err = run({
            "tool_name": "Agent",
            "tool_input": {"subagent_type": "vigil-test-keeper", "prompt": BRIEF_PROMPT},
        })
        self.assertEqual(code, 0, err)

    def test_non_dict_tool_input_fails_open_with_a_note(self):
        code, out, err = run({"tool_name": "Agent", "tool_input": "vigil-builder"})
        self.assertEqual(code, 0)
        self.assertEqual(out, "")
        self.assertIn("skipped", err)

    def test_non_object_json_payload_fails_open(self):
        """Valid JSON that parses to something other than an object (e.g. a bare list) must
        not reach `payload.get(...)`: that would raise AttributeError uncaught and exit 1,
        contradicting the "any internal error exits 0" fail-open contract."""
        result = subprocess.run(
            [sys.executable, "-B", str(SCRIPT)],
            input="[]",
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")

    def test_malformed_stdin_fails_open(self):
        result = subprocess.run(
            [sys.executable, "-B", str(SCRIPT)],
            input="not json",
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")


@unittest.skipUnless(TEMPLATE_AVAILABLE, "vigil-agent-build brief template not present yet")
class BriefMarkerTests(unittest.TestCase):
    """Guard the brief vocabulary: a renamed heading in the template the parent copies, or a
    detector narrowed to one marker, would let an implementation brief reach an unpinned agent
    with the hook still reporting success."""

    def test_every_brief_marker_still_appears_in_the_agent_brief_template(self):
        text = BRIEF_TEMPLATE.read_text(encoding="utf-8")
        for marker in HOOK.BRIEF_MARKERS:
            with self.subTest(marker=marker):
                self.assertIn(marker, text)

    def test_each_brief_marker_alone_denies_an_unpinned_spawn(self):
        for marker in HOOK.BRIEF_MARKERS:
            with self.subTest(marker=marker):
                reason = HOOK.check(
                    {"subagent_type": "general-purpose", "prompt": f"do a thing\n{marker} x"}
                )
                self.assertIsNotNone(reason)


@unittest.skipUnless(TEMPLATE_AVAILABLE, "vigil-agent-build brief template not present yet")
class EscalationRecordTemplateTests(unittest.TestCase):
    """Keep the hook's field names and the template the parent copies in step. A renamed or
    reworded field in the template reaches the hook two ways, both silent in production: the
    hook would demand a field no brief writes (denying every real handoff), or stop reading
    the template's own placeholder text as unfilled (letting boilerplate through)."""

    def test_every_record_field_appears_in_the_template_as_an_unfilled_placeholder(self):
        states = HOOK._record_states(_BRIEF_TEMPLATE_TEXT)
        for field in HOOK.RECORD_FIELDS + (HOOK.RISK_AREA_FIELD,):
            with self.subTest(field=field):
                self.assertEqual(states[field], HOOK.UNFILLED)

    def test_the_risk_area_fixture_rewrote_exactly_the_template_line(self):
        """The filled-Risk-area fixture is built by substitution; if the template's line
        changed shape the fixture would silently become a copy of the unfilled section."""
        self.assertEqual(_RISK_AREA_SUBS, 1)
        self.assertNotIn(TEMPLATE_RISK_AREA_LINE, RISK_AREA_WITH_UNFILLED_HANDOFF_PROMPT)

    def test_every_angle_bracket_chunk_in_the_record_section_is_read_as_a_placeholder(self):
        """The placeholder rule is narrow by design, so it can drift off the very text it
        exists to catch: a template placeholder reworded to start with a capital or to carry a
        colon would silently stop counting, and a pasted-but-unfilled record would pass."""
        chunks = set(ANY_ANGLE_CHUNK.findall(FULL_TEMPLATE_ESCALATION_SECTION))
        self.assertTrue(chunks)
        detected = {m.group(0) for m in HOOK.PLACEHOLDER.finditer(FULL_TEMPLATE_ESCALATION_SECTION)}
        self.assertEqual(chunks, detected)

    def test_the_template_s_other_sections_are_placeholders_too_and_hold_no_record_field(self):
        """The rest of the brief template is the same placeholder prose, and none of it names a
        record field -- so narrowing the rule changed nothing outside the record section."""
        chunks = set(ANY_ANGLE_CHUNK.findall(TEMPLATE_BODY_ABOVE_RECORD))
        self.assertTrue(chunks)
        detected = {m.group(0) for m in HOOK.PLACEHOLDER.finditer(TEMPLATE_BODY_ABOVE_RECORD)}
        self.assertEqual(chunks, detected)
        states = HOOK._record_states(TEMPLATE_BODY_ABOVE_RECORD)
        for field in HOOK.RECORD_FIELDS + (HOOK.RISK_AREA_FIELD,):
            with self.subTest(field=field):
                self.assertEqual(states[field], HOOK.ABSENT)

    def test_every_option_the_template_offers_is_an_approved_risk_area(self):
        """The template's `<ledger | ... >` list is the menu a parent copies from. An option
        it offers that the gate refuses denies a record written exactly as documented -- the
        worst failure this hook can have, because the writer did everything right."""
        options = [
            option.strip()
            for option in re.search(r"<([^<>]*)>", TEMPLATE_RISK_AREA_LINE).group(1).split("|")
        ]
        self.assertTrue(options)
        for option in options:
            with self.subTest(option=option):
                self.assertTrue(HOOK._is_approved_risk_area(option))

    def test_the_half_edited_fixtures_still_carry_the_template_s_own_placeholder_text(self):
        """Both half-edited fixtures are built by substitution on the template. If the
        template's wording moved, they would silently stop being half-edited -- one a fully
        filled line, the other a record with seven real values -- and prove nothing."""
        self.assertEqual(_PARTIAL_RISK_AREA_SUBS, 1)
        self.assertRegex(PARTIAL_RISK_AREA_LINE, r"<[^<>]*>")
        self.assertEqual(_LEFTOVER_TRIGGER_SUBS, 1)
        self.assertRegex(LEFTOVER_TRIGGER_PROMPT, r"(?m)^- Trigger:.*<[^<>]*>")


class PlaceholderValueTests(unittest.TestCase):
    """State the filled-versus-template rule on values directly. Every route through the gate
    rests on it, and a record-shaped fixture can pass for the wrong reason."""

    def test_a_value_still_carrying_template_prose_is_unfilled(self):
        for value in (
            "",
            "<why>",
            "migration -- <why>.",
            "<ledger | migration | authz | persistence/replay> -- <why>.",
            "<paths touched so far>.",
            "packages/ledger/src/journal.ts and <whatever else this touched>.",
            "<worktree>/",
        ):
            with self.subTest(value=value):
                self.assertFalse(HOOK._is_filled_value(value))

    def test_a_value_naming_real_facts_is_filled_even_around_a_quoted_path_root(self):
        for value in (
            "migration -- 0134 rewrites a hot table",
            "packages/ledger/src/journal.ts",
            "<worktree>/.claude/hooks/agent_policy.py",
            "packages/ledger/src/journal.ts, <worktree>/drizzle/0134_journal.sql",
        ):
            with self.subTest(value=value):
                self.assertTrue(HOOK._is_filled_value(value))

    def test_angle_brackets_that_are_not_the_template_s_shape_leave_a_value_filled(self):
        """Each of these is the reason the rule is shaped the way it is: a Markdown autolink
        (ruled out by the colon), a JSX tag (by the capital), and a generic (by the word
        character before `<`). Matching every `<...>` denied all three."""
        for value in (
            "<https://github.com/ceponatia/vigil/issues/560>",
            "the table renders <PositionTable /> twice",
            "the id is typed Record<string, Money>, so the cast drops it",
            "the helper returns Array<string> from the adapter",
        ):
            with self.subTest(value=value):
                self.assertTrue(HOOK._is_filled_value(value))

    def test_a_risk_area_value_needs_a_category_and_a_reason_not_a_category_alone(self):
        """Route B's one line is the whole record. These clear the placeholder rule -- they are
        real words, not template prose -- and still must not open the route, which is what the
        word count buys and the placeholder rule alone cannot."""
        for value in ("migration", "none", "authz -- new route"):
            with self.subTest(value=value):
                self.assertTrue(HOOK._is_filled_value(value))
                self.assertFalse(HOOK._is_filled_value(value, HOOK.RISK_AREA_MIN_WORDS))
        for value in (
            "migration -- 0134 rewrites a hot table",
            "ledger -- this slice rewrites the journal's posting order",
        ):
            with self.subTest(value=value):
                self.assertTrue(HOOK._is_filled_value(value, HOOK.RISK_AREA_MIN_WORDS))


class ImperativeBuildVerbTests(unittest.TestCase):
    """State the position rule on the helper directly. The verb list is a list of ordinary
    English words, so which position counts is the entire rule -- and a prompt-shaped fixture
    can pass for another reason (a template marker, a commit instruction) without touching it."""

    def test_a_build_verb_in_imperative_position_is_read_as_an_instruction(self):
        for prompt in (
            "implement the fix",  # the prompt's first word
            "Edit the hook",
            "Read the brief. Update the docstring.",  # a new sentence
            "Implement #560; edit the hook",
            "Look at it! Rewrite the helper.",
            "Read the brief\nadd a fixture",  # a new line
            "Steps:\n- add a fixture\n- rename the helper",  # a list item
            "  * delete the dead branch",
            "1. modify the regex",
            "2) remove the old rule",
            "please update the docstring",  # a discourse cue
            "Read it and edit the hook",
            "Look at the brief, then add a fixture",
            "Then, update the docstring",
            "Also: create the helper",
            "now fix the regex",
            "First fix the regex, next rewrite the comment, finally add a fixture",
        ):
            with self.subTest(prompt=prompt):
                self.assertTrue(HOOK._imperative_build_verb(prompt))

    def test_a_build_verb_anywhere_else_is_not(self):
        """Each of these is a word the rule looks for, sitting in a noun phrase. They are how
        people write about code, and the reason the verb list alone cannot carry the rule."""
        for prompt in (
            "summarize the write path",
            "give me an update on the docs",
            "trace the add flow through the reducer",
            "the create endpoint returns 500",
            "explain what the fix changed",
            "document the rename that landed last week",
            "check whether the delete cascade fires",
            "the write-ahead log is replayed on resume",
            "find where the repair is implemented",  # inflected, not the bare verb
            "the hook is rewritten on every push",
        ):
            with self.subTest(prompt=prompt):
                self.assertFalse(HOOK._imperative_build_verb(prompt))

    def test_after_a_discourse_cue_a_build_verb_needs_an_object(self):
        """`and` is the cue that does double duty: it joins clauses, and it joins noun
        phrases. In `the create and delete paths` the word after the cue modifies `paths`,
        and every build verb is also a noun modifier, so position alone put these on the
        instruction side. What tells them apart is what follows the verb -- an imperative
        takes a determiner or names a target outright."""
        for prompt in (
            "Compare the create and delete paths in foo.ts",
            "trace the add flow and create endpoint",
            "look at the read and write paths",
            "the guard and update ordering is what breaks",
            "then rewrite",  # a cue-led verb with nothing after it at all
        ):
            with self.subTest(prompt=prompt):
                self.assertFalse(HOOK._imperative_build_verb(prompt))

    def test_a_cue_led_verb_with_an_object_is_still_an_instruction(self):
        """The other direction of the same rule: a determiner, an issue number, a path or a
        filename after the verb is what a real cue-led instruction carries, and dropping any
        of them would leave the assignment a parent most often types uncaught."""
        for prompt in (
            "read the brief and update the hook",
            "Then update docs/testing.md.",
            "then add a fixture to .claude/hooks/test_agent_policy.py",
            "and fix #560",
            "please rewrite packages/ledger/src/journal.ts",
            "also delete this branch",
            "now modify every fixture",
        ):
            with self.subTest(prompt=prompt):
                self.assertTrue(HOOK._imperative_build_verb(prompt))

    def test_a_structural_position_needs_no_object(self):
        """The cue rule must not leak into the positions where nothing but an instruction can
        sit: a line, a list item or a sentence that opens with a build verb is an assignment
        whatever follows it, including nothing."""
        for prompt in (
            "Rewrite",
            "- delete",
            "Read the brief. Update.",
        ):
            with self.subTest(prompt=prompt):
                self.assertTrue(HOOK._imperative_build_verb(prompt))


class CommitSignalTests(unittest.TestCase):
    """State the commit rule on the helper directly. `commit` is an ordinary noun in review
    prose, so where the word sits is the entire rule -- and a prompt-shaped fixture can be
    denied for another reason (a template marker, a build verb beside a path) without ever
    touching it."""

    def test_an_instruction_to_commit_is_read_as_one(self):
        for prompt in (
            "commit the fix",  # the prompt's first word
            "Commit by pathspec in one commit.",
            "Then commit.",
            "Read the brief and commit the fix",  # a discourse cue
            "Do the work. Commit it.",  # a new sentence
            "Steps:\n- commit by pathspec",  # a list item
            "1. commit the fix",
            "please commit when the tests pass",
            "git commit -m 'wip'",  # the command at the head of the prompt
            "Then git commit -m 'wip'",  # and after a discourse cue
            "the rule here is to commit by pathspec",  # the template phrase, in any position
        ):
            with self.subTest(prompt=prompt):
                self.assertTrue(HOOK._has_commit_signal(prompt))

    def test_a_commit_named_in_prose_is_not(self):
        """Every one of these is research about a commit. The first two are why the rule
        moved: both put `commit` and `changes` in one sentence, which used to be the test,
        and reviewing a commit is an ordinary reason to spawn `general-purpose` at all."""
        for prompt in (
            "Review the changes in commit 2248b048 and summarize them",
            "Explain what changes the commit that broke CI introduced",
            "find the commit that renamed the helper",
            "summarize the changes since the last commit",
            "which commit fixed the flake?",
            "the commit message convention lives in AGENTS.md",
        ):
            with self.subTest(prompt=prompt):
                self.assertFalse(HOOK._has_commit_signal(prompt))

    def test_a_prompt_asking_about_the_git_command_is_not(self):
        """Why the git command moved into the position rule: a prompt about a forbidden
        command is exactly the prompt that spells the command out, so reading `git commit`
        as an instruction wherever it appeared denied unambiguously read-only research."""
        for prompt in (
            "Explain why git commit -a is forbidden in AGENTS.md",
            "The commit rule in AGENTS.md forbids git commit -a",
            "Summarize what git commit --amend does to a pushed branch",
        ):
            with self.subTest(prompt=prompt):
                self.assertFalse(HOOK._has_commit_signal(prompt))

    def test_a_git_command_quoted_at_the_head_of_a_line_is_a_documented_miss(self):
        """The price of the position rule, asserted so it stays a decision rather than a
        surprise. A backtick before the command breaks the lead, so a line opening with the
        quoted command reads as prose either way -- whether it forbids the command or tells
        the worker to run it. The rule is wrong in the direction that lets a prompt through,
        which is the direction this gate is deliberately wrong in; a brief that really
        assigns a commit also says `commit by pathspec`."""
        for prompt in (
            "`git commit -m x` is forbidden by AGENTS.md",
            "run `git commit` once CI is green",
        ):
            with self.subTest(prompt=prompt):
                self.assertFalse(HOOK._has_commit_signal(prompt))


class LeadingRiskCategoryTests(unittest.TestCase):
    """State the Route B category rule on the helper directly. A record-shaped fixture can be
    denied for a missing rationale or a stray placeholder without the category ever being
    read, so the two directions are asserted on the value itself."""

    def test_a_category_leading_with_an_approved_area_is_approved(self):
        """Anchoring must not cost the spellings writers actually use: a plural, the
        `persistence/replay` pairing, and the area followed by the writer's own words."""
        for value in (
            "ledger -- the journal's posting order",
            "ledger holdings drift — reconciliation posts through the wrong state",
            "migrations -- 0134 renames a column",
            "idempotency -- retries double-spend the same approved intent",
            "reconciliation -- the nightly reconcile job double-counts a fill",
            "authz — the new route needs an owner check",
            "authorization: the new route needs an owner check",
            "persistence/replay correctness -- replay drops the last fill",
            "replay -- resume drops the last fill event",
        ):
            with self.subTest(value=value):
                self.assertTrue(HOOK._is_approved_risk_area(value))

    def test_a_category_that_only_contains_an_approved_area_is_not(self):
        """Each of the first four names an approved area and then says it does not apply.
        Searching the category for the word approved every one of them."""
        for value in (
            "non-authorization -- this button needs careful visual polish",
            "unrelated to migration -- this button needs careful visual polish",
            "not a signer change -- this button needs careful visual polish",
            "no migration here -- the copy changes only",
            "styling -- this button needs careful visual polish",
        ):
            with self.subTest(value=value):
                self.assertFalse(HOOK._is_approved_risk_area(value))


class PinnedRoleTableTests(unittest.TestCase):
    """Keep the hook's table and the role files it enforces in step: a `vigil-*` role whose
    frontmatter pins a model but which PINNED omits is a role the policy silently stops
    protecting, and a mismatched entry makes the deny message name the wrong model."""

    def roles(self) -> dict:
        found = {}
        for path in sorted(ROLE_DIR.glob("*.md")):
            fields = role_frontmatter(path)
            name = fields.get("name", "")
            if name.startswith("vigil-"):
                found[name] = fields.get("model")
        return found

    def test_every_model_pinning_role_file_is_in_the_hook_table(self):
        found = self.roles()
        self.assertTrue(found)
        self.assertEqual({name for name, model in found.items() if model}, set(HOOK.PINNED))

    def test_hook_table_names_the_model_each_role_file_pins(self):
        for name, model in self.roles().items():
            with self.subTest(role=name):
                self.assertEqual(HOOK.PINNED_MODEL.get(name), model)


if __name__ == "__main__":
    unittest.main()
