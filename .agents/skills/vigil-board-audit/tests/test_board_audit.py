"""Offline fixtures for board-audit.py; never contact GitHub."""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / "board-audit.py"
SPEC = importlib.util.spec_from_file_location("board_audit", SCRIPT)
AUDIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT)

BOARD_TESTS = HERE.parent.parent / "vigil-board" / "tests"
PROJECT = "TESTPROJID1234"
WAITING, DECISION = AUDIT.WAITING, AUDIT.DECISION
OPTIONS = {
    "Status": ["Todo", WAITING, DECISION, "Ready", "In progress", "In review", "Done"],
    "Horizon": ["Now", "Next", "Backlog"],
    "Phase": ["Bootstrap & Paper", "Research Integration", "Live Canary", "Strategy Expansion", "Controlled Learning"],
    "Area": ["Data", "Ledger/Risk", "Execution", "Research", "Evaluation", "UI/Ops"],
    "Priority": ["Critical", "High", "Normal"],
    "Size": ["S", "M", "L", "XL"],
    "Owning role": ["Builder", "Escalation", "Research", "Owner"],
}


def body(dependencies="Blocked by: nothing.", scope="Land the slice.", outcome="For a developer: a thing."):
    return "\n".join([
        "## Outcome", outcome, "",
        "## Context and authoritative requirements", "Handoff §14.4.", "",
        "## Scope", scope, "",
        "## Out of scope", "Everything else.", "",
        "## Dependencies", dependencies, "",
        "## Acceptance criteria", "- [ ] It works.", "",
        "## Verification", "CI.", "",
        "## Safety / cost boundary", "PAPER-only.", "",
    ])


def issue(number, title, *, fields=None, parent=None, blocked_by=(), blocking=(), sub_issues=(),
          labels=(), assignees=(), state="OPEN", text=None, on_board=True):
    return {
        "number": number, "title": title, "state": state, "body": body() if text is None else text,
        "labels": list(labels), "assignees": list(assignees), "parent": parent,
        "sub_issues": [{"number": n, "state": "OPEN"} for n in sub_issues],
        "blocked_by": [{"number": n, "state": s} for n, s in blocked_by],
        "blocking": [{"number": n, "state": s} for n, s in blocking],
        "on_board": on_board, "item_id": f"ITEM{number}" if on_board else None,
        "fields": dict(fields or {}),
    }


FULL = {"Status": "Todo", "Horizon": "Now", "Phase": "Bootstrap & Paper", "Area": "Data",
        "Priority": "Normal", "Size": "M", "Owning role": "Builder"}
PARENT_FIELDS = {"Status": "Todo", "Horizon": "Now", "Phase": "Bootstrap & Paper", "Priority": "High"}


def codes(report, number):
    return [f["code"] for r in report["issues"] if r["number"] == number for f in r["findings"]]


def finding(report, number, code):
    for r in report["issues"]:
        if r["number"] == number:
            for f in r["findings"]:
                if f["code"] == code:
                    return f
    raise AssertionError(f"#{number} has no finding {code}; has {codes(report, number)}")


class BodyParsingTests(unittest.TestCase):
    def test_blocked_by_clause_stops_at_the_sentence_end_or_dash_aside(self):
        deps = "Blocked by: BOOT-04 (ledger). BOOT-06 (paper execution) is optional context, not a blocker."
        self.assertEqual(AUDIT.blocker_refs(deps), ["BOOT-04"])
        deps = "Blocked by: BOOT-03 (assets), BOOT-04 (ledger), BOOT-05 (plan) — this issue consumes all three."
        self.assertEqual(AUDIT.blocker_refs(deps), ["BOOT-03", "BOOT-04", "BOOT-05"])
        self.assertEqual(AUDIT.blocker_refs("Blocked by: #4 and #7; BOOT-02 is context."), ["#4", "#7"])
        self.assertEqual(AUDIT.blocker_refs("None — first sub-issue. Blocked by: nothing."), [])

    def test_sections_and_completeness(self):
        parts = AUDIT.sections(body())
        self.assertEqual(set(parts), set(AUDIT.SECTIONS))
        self.assertTrue(AUDIT.body_complete(body()))
        self.assertFalse(AUDIT.body_complete(body().replace("PAPER-only.", "")))

    def test_parent_reference_forms(self):
        for text in ("Part of #3.", "Sub-issue of #3", "Parent: #3", "parent issue #3"):
            self.assertEqual(AUDIT.parent_ref(text), 3, text)
        self.assertIsNone(AUDIT.parent_ref("no parent here"))


class SnapshotTests(unittest.TestCase):
    def test_graphql_node_flattens_to_the_audit_shape(self):
        node = {
            "number": 9, "title": "BOOT-06: Paper execution", "state": "OPEN", "body": body(),
            "labels": {"nodes": [{"name": "research"}]}, "assignees": {"nodes": []},
            "parent": {"number": 3}, "subIssues": {"totalCount": 0, "nodes": []},
            "blockedBy": {"nodes": [{"number": 7, "state": "OPEN"}]}, "blocking": {"nodes": [{"number": 11, "state": "OPEN"}]},
            "projectItems": {"nodes": [
                {"id": "OTHER", "project": {"id": "OTHERPROJ"}, "fieldValues": {"nodes": [{"name": "Done", "field": {"name": "Status"}}]}},
                {"id": "ITEM9", "project": {"id": PROJECT}, "fieldValues": {"nodes": [
                    {}, {"name": "Todo", "field": {"name": "Status"}}, {"name": "Execution", "field": {"name": "Area"}},
                    {"text": "https://ci.example/runs/1", "field": {"name": "Evidence"}},
                    {"text": "", "field": {"name": "Notes"}}]}},
            ]},
        }
        snap = AUDIT.snapshot(node, PROJECT)
        self.assertTrue(snap["on_board"])
        self.assertEqual(snap["item_id"], "ITEM9")
        self.assertEqual(snap["fields"], {"Status": "Todo", "Area": "Execution", "Evidence": "https://ci.example/runs/1"})
        self.assertEqual(snap["parent"], 3)
        self.assertEqual(snap["blocked_by"], [{"number": 7, "state": "OPEN"}])
        self.assertEqual(snap["labels"], ["research"])

    def test_an_issue_on_another_project_only_is_not_on_this_board(self):
        node = {
            "number": 2, "title": "x", "state": "OPEN", "body": "", "labels": {"nodes": []}, "assignees": {"nodes": []},
            "parent": None, "subIssues": {"totalCount": 0, "nodes": []}, "blockedBy": {"nodes": []}, "blocking": {"nodes": []},
            "projectItems": {"nodes": [{"id": "X", "project": {"id": "OTHER"}, "fieldValues": {"nodes": []}}]},
        }
        self.assertFalse(AUDIT.snapshot(node, PROJECT)["on_board"])


class AuditTests(unittest.TestCase):
    def test_a_complete_batch_has_no_findings_and_only_the_parent_optional_info(self):
        batch = {
            3: issue(3, "Umbrella", fields=PARENT_FIELDS, sub_issues=(4, 5)),
            4: issue(4, "BOOT-01: Skeleton", fields=FULL | {"Status": "Ready"}, parent=3, blocking=((5, "OPEN"),)),
            5: issue(5, "BOOT-02: Research", fields=FULL | {"Status": WAITING}, parent=3, blocked_by=((4, "OPEN"),),
                     text=body(dependencies="Blocked by: BOOT-01 (skeleton).")),
        }
        report = AUDIT.audit(batch, OPTIONS, parent_arg=3)
        self.assertEqual(report["summary"]["findings"], 0)
        self.assertEqual(codes(report, 3), ["area-unset-on-parent", "size-unset-on-parent", "owning-role-unset-on-parent"])
        self.assertEqual(codes(report, 4), [])
        self.assertEqual(codes(report, 5), [])

    def test_missing_fields_are_derived_from_the_parent_then_the_planning_id(self):
        batch = {
            3: issue(3, "Umbrella", fields=PARENT_FIELDS, sub_issues=(6,)),
            6: issue(6, "BOOT-04: Ledger", fields={}, parent=3,
                     text=body(scope="`packages/ledger` journal entries, reservations, and balances in `packages/db` with a migration.")),
            12: issue(12, "BACK-02: One approved yield adapter", fields={}),
        }
        report = AUDIT.audit(batch, OPTIONS)
        self.assertEqual(finding(report, 6, "missing-field:Horizon")["suggestion"], "Now")
        self.assertIn("inherited from parent #3", finding(report, 6, "missing-field:Horizon")["rule"])
        self.assertEqual(finding(report, 6, "missing-field:Phase")["suggestion"], "Bootstrap & Paper")
        self.assertEqual(finding(report, 6, "missing-field:Area")["suggestion"], "Ledger/Risk")
        self.assertEqual(finding(report, 6, "missing-field:Status")["suggestion"], "Ready")
        self.assertEqual(finding(report, 6, "missing-field:Priority")["suggestion"], "Normal")
        self.assertEqual(finding(report, 6, "missing-field:Area")["fix"],
                         '.agents/skills/vigil-board/board-set.sh 6 "Area" "Ledger/Risk"')
        role = finding(report, 6, "missing-field:Owning role")
        self.assertEqual(role["suggestion"], "Escalation")
        self.assertIn("ledger", role["rule"])
        self.assertIn("migration", role["rule"])
        self.assertEqual(role["fix"], '.agents/skills/vigil-board/board-set.sh 6 "Owning role" "Escalation"')
        size = finding(report, 6, "missing-field:Size")
        self.assertIsNone(size.get("suggestion"))
        self.assertFalse(size["fixable"])
        self.assertIn("S ≈ 10 minutes", size["rule"])
        self.assertEqual(finding(report, 12, "missing-field:Horizon")["suggestion"], "Backlog")
        self.assertEqual(finding(report, 12, "missing-field:Phase")["suggestion"], "Strategy Expansion")
        self.assertEqual(finding(report, 12, "missing-field:Owning role")["suggestion"], "Builder")

    def test_one_risk_area_mention_is_ambiguous_not_escalation(self):
        batch = {
            10: issue(10, "BOOT-07: Dashboard", fields={},
                      text=body(scope="`apps/control` imports only `contracts`, `db`, `policy`; shows holdings.")),
            11: issue(11, "BOOT-08: Acceptance", fields={},
                      text=body(scope="A replay under tests/replay and fault cases for reconciliation; reconciled journal.")),
        }
        report = AUDIT.audit(batch, OPTIONS)
        single = finding(report, 10, "missing-field:Owning role")
        self.assertIsNone(single.get("suggestion"))
        self.assertIn("ambiguous", single["rule"])
        self.assertIn("policy", single["rule"])
        double = finding(report, 11, "missing-field:Owning role")
        self.assertEqual(double["suggestion"], "Escalation")
        self.assertEqual(double["rule"], "risk areas named in title/Outcome/Scope: reconciliation, replay")

    def test_owning_role_follows_the_labels_before_the_risk_areas(self):
        batch = {
            5: issue(5, "BOOT-02: Venue research", fields={}, labels=("research",),
                     text=body(scope="Compare execution and signing capabilities.")),
            13: issue(13, "Decide the first chain", fields={}, labels=("decision-needed",)),
        }
        report = AUDIT.audit(batch, OPTIONS)
        self.assertEqual(finding(report, 5, "missing-field:Owning role")["suggestion"], "Research")
        self.assertEqual(finding(report, 13, "missing-field:Owning role")["suggestion"], "Owner")
        self.assertEqual(finding(report, 13, "missing-field:Status")["suggestion"], DECISION)

    def test_a_suggestion_outside_the_live_options_is_withheld(self):
        options = dict(OPTIONS, Horizon=["Soon", "Later"])
        batch = {4: issue(4, "BOOT-01: Skeleton", fields={k: v for k, v in FULL.items() if k != "Horizon"})}
        found = finding(AUDIT.audit(batch, options), 4, "missing-field:Horizon")
        self.assertIsNone(found.get("suggestion"))
        self.assertFalse(found["fixable"])
        self.assertIn("no live option named 'Now'", found["rule"])

    def test_priority_is_high_only_when_the_issue_blocks_two_batch_issues(self):
        batch = {
            4: issue(4, "BOOT-01: Skeleton", fields={k: v for k, v in FULL.items() if k != "Priority"},
                     blocking=((5, "OPEN"), (6, "OPEN"), (99, "OPEN"))),
            5: issue(5, "BOOT-02: R", fields=FULL | {"Status": WAITING}, blocked_by=((4, "OPEN"),), text=body(dependencies="Blocked by: #4.")),
            6: issue(6, "BOOT-04: L", fields=FULL | {"Status": WAITING}, blocked_by=((4, "OPEN"),), text=body(dependencies="Blocked by: #4.")),
        }
        found = finding(AUDIT.audit(batch, OPTIONS), 4, "missing-field:Priority")
        self.assertEqual(found["suggestion"], "High")
        self.assertIn("#5, #6", found["rule"])
        self.assertNotIn("#99", found["rule"])

    def test_a_blocker_named_in_the_body_without_a_native_link_is_fixable(self):
        batch = {
            4: issue(4, "BOOT-01: Skeleton", fields=FULL),
            7: issue(7, "BOOT-03: Market", fields=FULL, text=body(dependencies="Blocked by: BOOT-01 (skeleton). BOOT-02 is optional context.")),
        }
        report = AUDIT.audit(batch, OPTIONS)
        found = finding(report, 7, "body-blocker-unlinked:#4")
        self.assertTrue(found["fixable"])
        self.assertEqual(found["fix"], ".agents/skills/vigil-board/file-issue.sh --issue 7 --blocked-by 4")
        self.assertNotIn("body-blocker-unresolved:BOOT-02", codes(report, 7))

    def test_an_unresolvable_planning_id_and_an_unnamed_native_link_are_reported(self):
        batch = {
            7: issue(7, "BOOT-03: Market", fields=FULL | {"Status": WAITING}, blocked_by=((4, "OPEN"),),
                     text=body(dependencies="Blocked by: BOOT-09.")),
        }
        report = AUDIT.audit(batch, OPTIONS)
        self.assertIn("body-blocker-unresolved:BOOT-09", codes(report, 7))
        self.assertEqual(finding(report, 7, "native-blocker-unnamed:#4")["severity"], "info")

    def test_status_follows_the_native_blockers(self):
        batch = {
            4: issue(4, "BOOT-01: A", fields=FULL | {"Status": "Ready"}, blocked_by=((3, "OPEN"),), text=body(dependencies="Blocked by: #3.")),
            5: issue(5, "BOOT-02: B", fields=FULL | {"Status": "Todo"}, blocked_by=((3, "OPEN"),), text=body(dependencies="Blocked by: #3.")),
            6: issue(6, "BOOT-04: C", fields=FULL | {"Status": WAITING}, blocked_by=((3, "CLOSED"),), text=body(dependencies="Blocked by: #3.")),
            7: issue(7, "BOOT-03: D", fields=FULL | {"Status": WAITING}, blocked_by=((3, "OPEN"),), text=body(dependencies="Blocked by: #3.")),
            8: issue(8, "BOOT-05: E", fields=FULL | {"Status": "Todo"}),
        }
        report = AUDIT.audit(batch, OPTIONS)
        for n in (4, 5):
            found = finding(report, n, "status-vs-blockers")
            self.assertEqual(found["suggestion"], WAITING)
            self.assertEqual(found["fix"], f'.agents/skills/vigil-board/board-set.sh {n} Status "{WAITING}"')
        released = finding(report, 6, "waiting-without-open-blocker")
        self.assertEqual(released["suggestion"], "Ready")
        self.assertEqual(released["fix"], ".agents/skills/vigil-board/board-set.sh 6 Status Ready")
        self.assertEqual(codes(report, 7), [])
        self.assertEqual(finding(report, 8, "todo-but-unblocked")["severity"], "info")

    def test_decision_states_and_the_assignment_convention(self):
        batch = {
            5: issue(5, "BOOT-02: R", fields=FULL | {"Status": "Todo"}, assignees=("ceponatia",)),
            6: issue(6, "BOOT-04: L", fields=FULL | {"Status": "In review"}),
            8: issue(8, "Choose the chain", fields=FULL | {"Status": DECISION}, assignees=("ceponatia",)),
            9: issue(9, "Choose the signer", fields=FULL | {"Status": DECISION}),
            10: issue(10, "Choose the stablecoin", fields=FULL | {"Status": "Todo"}, labels=("decision-needed",)),
            11: issue(11, "BOOT-06: E", fields=FULL | {"Status": "Done"}),
            12: issue(12, "BOOT-07: D", fields=FULL | {"Status": "In progress"}, state="CLOSED"),
        }
        report = AUDIT.audit(batch, OPTIONS)
        self.assertEqual(finding(report, 5, "assigned-outside-owner-turn")["fixable"], False)
        self.assertEqual(finding(report, 6, "owner-turn-unassigned")["fix"], ".agents/skills/vigil-board/board-set.sh 6 --assign")
        self.assertEqual(codes(report, 8), ["needs-decision-without-label"])
        self.assertEqual(finding(report, 9, "owner-turn-unassigned")["fixable"], True)
        self.assertEqual(finding(report, 10, "decision-label-outside-needs-decision")["suggestion"], DECISION)
        self.assertNotIn("todo-but-unblocked", codes(report, 10))
        self.assertEqual(finding(report, 11, "done-but-open")["severity"], "finding")
        self.assertEqual(finding(report, 12, "closed-not-done")["severity"], "info")

    def test_a_closed_done_issue_keeps_its_assignee_without_a_finding(self):
        # #4 stays assigned to the owner and Done after the owner merged PR #12; the
        # assignment convention in vigil-board's lifecycle.md governs open items only,
        # so a closed issue's existing assignee is never a finding.
        batch = {
            4: issue(4, "BOOT-01: first code slice", fields=FULL | {
                "Status": "Done", "Evidence": "https://github.com/ceponatia/vigil/pull/12",
            }, assignees=("ceponatia",), state="CLOSED"),
        }
        report = AUDIT.audit(batch, OPTIONS)
        self.assertEqual(codes(report, 4), [])

    def test_a_closed_issue_in_review_is_never_told_to_assign_the_owner(self):
        # Kills the fixable `owner-turn-unassigned` finding on a closed issue: its
        # `--assign` fix would mutate an issue nobody can act on any more, and
        # In review on a closed issue only means the Status field was never moved
        # to Done — `closed-not-done` already reports that, and it is all that is
        # left here. The convention still binds open issues:
        # test_decision_states_and_the_assignment_convention keeps #6 and #9
        # finding-bearing, so this is a narrowing by state, not a removal.
        batch = {
            6: issue(6, "BOOT-04: L", fields=FULL | {
                "Status": "In review", "Evidence": "https://ci.example/runs/9",
            }, state="CLOSED"),
        }
        report = AUDIT.audit(batch, OPTIONS)
        self.assertEqual(codes(report, 6), ["closed-not-done"])

    def test_evidence_is_required_once_built_or_accepted(self):
        batch = {
            6: issue(6, "BOOT-04: L", fields=FULL | {"Status": "In review"}, assignees=("ceponatia",)),
            7: issue(7, "BOOT-03: M", fields=FULL | {"Status": "In review", "Evidence": "https://ci.example/runs/9"}, assignees=("ceponatia",)),
            8: issue(8, "BOOT-05: N", fields=FULL | {"Status": "Ready"}),
        }
        report = AUDIT.audit(batch, OPTIONS)
        found = finding(report, 6, "missing-field:Evidence")
        self.assertFalse(found["fixable"])
        self.assertIn("Evidence", found["detail"])
        self.assertEqual(codes(report, 7), [])
        self.assertNotIn("missing-field:Evidence", codes(report, 8))

    def test_labels_bodies_parents_and_board_membership(self):
        text = body().replace("## Verification\nCI.\n", "## Verification\n\n").replace("## Out of scope\nEverything else.\n\n", "")
        batch = {
            3: issue(3, "Umbrella", fields=PARENT_FIELDS | {"Area": "Data"}, sub_issues=(4,)),
            4: issue(4, "BOOT-01: Skeleton", fields=FULL, labels=("enhancement", "research"), on_board=False, text=text + "\nPart of #3."),
            5: issue(5, "BOOT-01: Twin", fields=FULL, parent=3),
        }
        report = AUDIT.audit(batch, OPTIONS, parent_arg=3)
        found = codes(report, 4)
        self.assertIn("not-on-board", found)
        self.assertIn("label-outside-taxonomy:enhancement", found)
        self.assertNotIn("label-outside-taxonomy:research", found)
        self.assertIn("body-section-missing:Out of scope", found)
        self.assertIn("body-section-empty:Verification", found)
        self.assertEqual(finding(report, 4, "parent-unlinked:#3")["fix"], ".agents/skills/vigil-board/file-issue.sh --issue 4 --parent 3")
        self.assertEqual([f["code"] for f in report["batch_findings"]], ["duplicate-planning-id:BOOT-01"])
        self.assertNotIn("parent-unlinked:#3", codes(report, 5))

    def test_a_set_horizon_that_disagrees_with_derivation_is_info_never_a_fix(self):
        batch = {4: issue(4, "NEXT-02: Adapter", fields=FULL | {"Horizon": "Now"})}
        found = finding(AUDIT.audit(batch, OPTIONS), 4, "field-vs-derivation:Horizon")
        self.assertEqual(found["severity"], "info")
        self.assertEqual(found["suggestion"], "Next")
        self.assertNotIn("fix", found)


class ProcessTests(unittest.TestCase):
    """Run the script as the agent does, against a fake gh on PATH."""

    def run_script(self, args, env_file, batch=None, fields=None):
        tmp = tempfile.mkdtemp()
        bin_dir = Path(tmp, "bin")
        bin_dir.mkdir()
        os.symlink(HERE / "fake-gh.sh", bin_dir / "gh")
        batch_file = Path(tmp, "batch.json")
        fields_file = Path(tmp, "fields.json")
        batch_file.write_text(json.dumps(batch or {}))
        fields_file.write_text(json.dumps(fields or {}))
        env = dict(os.environ, PATH=f"{bin_dir}:{os.environ['PATH']}", VIGIL_BOARD_ENV=str(env_file),
                   TEST_STATE_DIR=tmp, FAKE_GH_BATCH=str(batch_file), FAKE_GH_FIELDS=str(fields_file))
        proc = subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True, env=env)
        calls = Path(tmp, "calls")
        return proc, calls.read_text() if calls.exists() else ""

    def graphql_batch(self):
        def node(number, title, fields, parent=None, subs=()):
            return {
                "number": number, "title": title, "state": "OPEN", "body": body(), "createdAt": "2026-09-12T18:00:00Z",
                "labels": {"nodes": []}, "assignees": {"nodes": []}, "parent": ({"number": parent} if parent else None),
                "subIssues": {"totalCount": len(subs), "nodes": [{"number": n, "state": "OPEN"} for n in subs]},
                "blockedBy": {"nodes": []}, "blocking": {"nodes": []},
                "projectItems": {"nodes": [{"id": f"ITEM{number}", "project": {"id": PROJECT}, "fieldValues": {"nodes": [
                    {"name": v, "field": {"name": k}} for k, v in fields.items()]}}]},
            }
        return {"data": {"repository": {
            "i3": node(3, "Umbrella", PARENT_FIELDS, subs=(4,)),
            "i4": node(4, "BOOT-01: Skeleton", {k: v for k, v in (FULL | {"Status": "Ready"}).items() if k != "Area"}, parent=3),
        }}}

    def graphql_fields(self):
        return {"data": {"node": {"fields": {"nodes": [{}] + [
            {"name": name, "options": [{"name": o} for o in options]} for name, options in OPTIONS.items()]}}}}

    def test_unconfigured_board_env_fails_before_any_gh_call(self):
        proc, calls = self.run_script(["--parent", "3"], BOARD_TESTS / "board-unconfigured.env")
        self.assertEqual(proc.returncode, 78, proc.stderr)
        self.assertIn("not configured: set VIGIL_BOARD_PROJECT_ID in", proc.stderr)
        self.assertEqual(calls, "")

    def test_no_selector_is_a_usage_error(self):
        proc, _ = self.run_script([], BOARD_TESTS / "board.env")
        self.assertEqual(proc.returncode, 64)

    def test_parent_expansion_reports_findings_as_json_and_exits_3(self):
        proc, calls = self.run_script(["--parent", "3", "--json"], BOARD_TESTS / "board.env",
                                      batch=self.graphql_batch(), fields=self.graphql_fields())
        self.assertEqual(proc.returncode, 3, proc.stderr)
        report = json.loads(proc.stdout)
        self.assertEqual([i["number"] for i in report["issues"]], [3, 4])
        self.assertEqual(report["repo"], "ceponatia/vigil-fixture")
        self.assertIn("missing-field:Area", [f["code"] for f in report["issues"][1]["findings"]])
        self.assertIn("owner=ceponatia", calls)
        self.assertIn("name=vigil-fixture", calls)
        self.assertNotIn("-X POST", calls)
        self.assertNotIn("mutation", calls)

    def test_a_clean_batch_exits_zero_in_text_mode(self):
        batch = self.graphql_batch()
        batch["data"]["repository"]["i4"]["projectItems"]["nodes"][0]["fieldValues"]["nodes"].append(
            {"name": "UI/Ops", "field": {"name": "Area"}})
        proc, _ = self.run_script(["3", "4"], BOARD_TESTS / "board.env", batch=batch, fields=self.graphql_fields())
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("2 issues, 0 findings (0 fixable), 3 info", proc.stdout)
        self.assertIn("area-unset-on-parent", proc.stdout)
        self.assertIn("size-unset-on-parent", proc.stdout)


if __name__ == "__main__":
    unittest.main()
