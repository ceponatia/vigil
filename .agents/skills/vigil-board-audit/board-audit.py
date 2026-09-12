#!/usr/bin/env python3
"""Read-only audit of a batch of Vigil issues against the Vigil Development board.

  board-audit.py 3 4 5 6                        # explicit issue numbers
  board-audit.py --parent 3                     # a parent issue plus every sub-issue
  board-audit.py --since 2026-09-12T18:00:00Z   # every issue created at or after
  board-audit.py --parent 3 --json              # machine-readable report

For every issue it prints the saved board state (membership, Status, Horizon,
Phase, Area, Priority, Size, Owning role, Evidence), labels, assignees,
parent, and blocked-by links, then the findings: a classification field the
filer left unset, a blocker the body names that has no native link, a parent
the body names that is not linked, a Status that contradicts the open
blockers, an assignee outside the owner's turn, a label outside the board
taxonomy, or a body missing a template section. For each missing field it
derives a suggestion and names the rule that produced it
(references/derivation.md), validated against the board's live option names.

Reads board identity from the vigil-board skill's board.env (or the file named
by $VIGIL_BOARD_ENV) and refuses to run while a value still reads
TODO(bootstrap). It never mutates anything: fixes go through
.agents/skills/vigil-board/board-set.sh and file-issue.sh --issue N.

Exit status: 0 no findings (info-only reports still exit 0); 3 at least one
finding; 64 usage; 78 board not configured; 1 GitHub API failure.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_ENV = HERE.parent / "vigil-board" / "board.env"
BOARD_SET = ".agents/skills/vigil-board/board-set.sh"
FILE_ISSUE = ".agents/skills/vigil-board/file-issue.sh"

EXIT_CLEAN, EXIT_API, EXIT_FINDINGS, EXIT_USAGE, EXIT_UNCONFIGURED = 0, 1, 3, 64, 78
CHUNK = 20  # issues per GraphQL round trip

# Every leaf issue carries all of these. A parent (an issue with sub-issues) may
# leave the PARENT_OPTIONAL ones unset: it spans areas, sizes, and roles.
CLASSIFICATION = ("Status", "Horizon", "Phase", "Area", "Priority", "Size", "Owning role")
PARENT_OPTIONAL = {"Area", "Size", "Owning role"}
# Evidence is a text field, required only once an issue claims to be built or accepted.
EVIDENCE_STATUSES = {"In review", "Done"}
WAITING, DECISION = "Waiting on dependency", "Needs decision"

SECTIONS = (
    "Outcome",
    "Context and authoritative requirements",
    "Scope",
    "Out of scope",
    "Dependencies",
    "Acceptance criteria",
    "Verification",
    "Safety / cost boundary",
)
# Mirrors TAXONOMY in file-issue.sh; a label outside it is reported, never removed.
TAXONOMY = {
    "bug", "technical-debt", "performance", "security", "documentation",
    "research", "evaluation", "initiative", "decision-needed", "agent-found",
}
PLANNING_ID = re.compile(r"\b(BOOT|NEXT|BACK)-(\d{2})\b")
ISSUE_REF = re.compile(r"#(\d+)\b")
PARENT_REF = re.compile(r"(?:part of|sub-issue of|parent(?: issue)?:?)\s*#(\d+)", re.IGNORECASE)
BLOCKED_BY = re.compile(r"blocked by\s*:?\s*", re.IGNORECASE)
# Where a "Blocked by:" clause ends: a sentence end, a dash aside, a semicolon, or a line.
CLAUSE_END = re.compile(r"\.(?:\s|$)|\s[—–]\s|;|\n")
HEADING = re.compile(r"^##\s+(.+?)\s*$", re.MULTILINE)
# AGENTS.md's escalation-owned risk areas, read over the title, Outcome, and Scope.
RISK_AREA = re.compile(
    r"\b(ledger|policy|execution|signer|signing|migrations?|authz|authorization|persistence"
    r"|replay|idempoten\w*|reconcil\w*)\b",
    re.IGNORECASE,
)
# Word forms collapse to one family so "reconciled" and "reconciliation" count once.
RISK_AREA_FAMILY = {
    "signin": "signer", "migrat": "migration", "author": "authorization", "idempo": "idempotency",
    "reconc": "reconciliation",
}
SIZE_RULE = ("Size is the filing brief's estimate of agent time: S ≈ 10 minutes, M ≈ an hour, "
             "L ≈ half a day, XL ≈ a day (the cap; larger work is a parent with sub-issues)")

# Planning conventions from the handoff (§14.4, §14.5) mapped onto the board's field
# vocabulary. Every suggestion is checked against the live option names before it is
# offered, so a renamed option turns into "no live option named …", never a wrong write.
HORIZON_BY_PREFIX = {"BOOT": "Now", "NEXT": "Next", "BACK": "Backlog"}
PHASE_BY_PLANNING_ID = {
    "BOOT": "Bootstrap & Paper",
    "NEXT-01": "Research Integration",
    "NEXT-02": "Live Canary",
    "NEXT-03": "Live Canary",
    "NEXT-04": "Controlled Learning",
    "BACK-01": "Strategy Expansion",
    "BACK-02": "Strategy Expansion",
    "BACK-03": "Strategy Expansion",
    "BACK-04": "Controlled Learning",
}
# Area is a heuristic over the title, Outcome, and Scope only (Context and Out of scope
# name neighbouring areas on purpose). Offered only when one area wins outright.
AREA_KEYWORDS = {
    "Data": (
        r"packages/market", r"\bmarket\b", r"\bquotes?\b", r"\bfixtures?\b", r"\brecording\b",
        r"asset identit", r"\bsnapshots?\b", r"\bfreshness\b", r"\binstruments?\b",
    ),
    "Ledger/Risk": (
        r"packages/ledger", r"\bledger\b", r"\bjournal\b", r"\breservations?\b", r"packages/policy",
        r"\bpolicy checks?\b", r"\brisk limits?\b", r"\bmigrations?\b", r"packages/db", r"\bholdings\b",
        r"\bbalances?\b",
    ),
    "Execution": (
        r"adapter-", r"\bexecution\b", r"\bintents?\b", r"\borders?\b", r"\bsigner\b", r"\bfills?\b",
        r"apps/trading", r"\bidempoten",
    ),
    "Research": (
        r"packages/strategies", r"\bcandidates?\b", r"\bLLM\b", r"\bresearch\b", r"\bevidence\b",
        r"\bthesis\b", r"\bvenue economics\b", r"\bcapabilit",
    ),
    "Evaluation": (
        r"tests/replay", r"fault-injection", r"\bacceptance\b", r"\bevaluation\b", r"\bbenchmark",
        r"\boutcomes?\b", r"\bcounterfactual", r"\breplay\b",
    ),
    "UI/Ops": (
        r"apps/control", r"\bdashboard\b", r"\bCI\b", r"\brunbooks?\b", r"\bhosting\b", r"\btooling\b",
        r"\bworkflows?\b", r"\bheartbeats?\b", r"\bgates?\b", r"\bbanner\b",
    ),
}

ISSUE_FRAGMENT = """fragment IssueFields on Issue {
  number title state body createdAt
  labels(first: 30) { nodes { name } }
  assignees(first: 10) { nodes { login } }
  parent { number }
  subIssues(first: 100) { totalCount nodes { number state } }
  blockedBy(first: 50) { nodes { ... on Issue { number state } } }
  blocking(first: 50) { nodes { ... on Issue { number state } } }
  projectItems(first: 20) { nodes { id project { id } fieldValues(first: 30) { nodes {
    ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } }
    ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2Field { name } } }
  } } } }
}"""
FIELDS_QUERY = """query($project: ID!) { node(id: $project) { ... on ProjectV2 {
  fields(first: 50) { nodes { ... on ProjectV2SingleSelectField { name options { name } } } } } } }"""


class ApiError(RuntimeError):
    pass


# --- configuration --------------------------------------------------------------------

def load_env(path: Path) -> dict[str, str]:
    """Parse the KEY=VALUE lines of a board.env the way the bash helpers `source` it."""
    values: dict[str, str] = {}
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key.strip()] = value
    return values


def require(values: dict[str, str], key: str, path: Path) -> str:
    value = values.get(key, "")
    if not value or value.startswith("TODO(bootstrap)"):
        print(f"not configured: set {key} in {path}", file=sys.stderr)
        sys.exit(EXIT_UNCONFIGURED)
    return value


# --- GitHub reads ---------------------------------------------------------------------

def gh_json(*args: str):
    proc = subprocess.run(["gh", *args], capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        raise ApiError((proc.stderr or proc.stdout).strip() or f"gh {' '.join(args[:2])} failed")
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise ApiError(f"gh returned non-JSON output: {exc}") from exc


def fetch_issues(owner: str, name: str, numbers: list[int]) -> dict[int, dict]:
    nodes: dict[int, dict] = {}
    for start in range(0, len(numbers), CHUNK):
        chunk = numbers[start:start + CHUNK]
        selections = "\n".join(f"i{n}: issue(number: {n}) {{ ...IssueFields }}" for n in chunk)
        query = (
            "query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {\n"
            f"{selections}\n}} }}\n{ISSUE_FRAGMENT}"
        )
        data = gh_json("api", "graphql", "-f", f"owner={owner}", "-f", f"name={name}", "-f", f"query={query}")
        repo = (data.get("data") or {}).get("repository") or {}
        for n in chunk:
            node = repo.get(f"i{n}")
            if node is None:
                raise ApiError(f"issue #{n} was not found in {owner}/{name}")
            nodes[n] = node
    return nodes


def fetch_fields(project_id: str) -> dict[str, list[str]]:
    data = gh_json("api", "graphql", "-f", f"project={project_id}", "-f", f"query={FIELDS_QUERY}")
    out: dict[str, list[str]] = {}
    for field in (((data.get("data") or {}).get("node") or {}).get("fields") or {}).get("nodes", []):
        if field and field.get("name"):
            out[field["name"]] = [o["name"] for o in field.get("options", [])]
    return out


def fetch_since(repo: str, since: str) -> list[int]:
    data = gh_json(
        "issue", "list", "--repo", repo, "--state", "all", "--limit", "200",
        "--search", f"created:>={since}", "--json", "number",
    )
    return sorted(int(row["number"]) for row in data)


# --- normalisation and body parsing ---------------------------------------------------

def snapshot(node: dict, project_id: str) -> dict:
    """Flatten one GraphQL issue node into the shape audit() reads."""
    item = next((i for i in node["projectItems"]["nodes"] if (i.get("project") or {}).get("id") == project_id), None)
    fields: dict[str, str] = {}
    if item:
        for value in item["fieldValues"]["nodes"]:
            if not value or not value.get("field"):
                continue
            if value.get("name") is not None:
                fields[value["field"]["name"]] = value["name"]
            elif value.get("text"):
                fields[value["field"]["name"]] = value["text"]
    return {
        "number": node["number"],
        "title": node.get("title") or "",
        "state": node.get("state") or "OPEN",
        "body": node.get("body") or "",
        "labels": [l["name"] for l in node["labels"]["nodes"]],
        "assignees": [a["login"] for a in node["assignees"]["nodes"]],
        "parent": (node.get("parent") or {}).get("number"),
        "sub_issues": [{"number": s["number"], "state": s["state"]} for s in node["subIssues"]["nodes"]],
        "blocked_by": [{"number": b["number"], "state": b["state"]} for b in node["blockedBy"]["nodes"] if b],
        "blocking": [{"number": b["number"], "state": b["state"]} for b in node["blocking"]["nodes"] if b],
        "on_board": item is not None,
        "item_id": item["id"] if item else None,
        "fields": fields,
    }


def sections(body: str) -> dict[str, str]:
    found: dict[str, str] = {}
    matches = list(HEADING.finditer(body))
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(body)
        found[match.group(1)] = body[match.end():end].strip()
    return found


def planning_id(text: str) -> str | None:
    match = PLANNING_ID.search(text)
    return f"{match.group(1)}-{match.group(2)}" if match else None


def blocker_refs(dependencies: str) -> list[str]:
    """Planning IDs and #numbers named as blockers: the clause after each "Blocked by:",
    up to the first sentence end, dash aside, semicolon, or line break — so
    "Blocked by: BOOT-04. BOOT-06 is optional context" names only BOOT-04."""
    refs: list[str] = []
    for match in BLOCKED_BY.finditer(dependencies):
        rest = dependencies[match.end():]
        end = CLAUSE_END.search(rest)
        clause = rest[: end.start()] if end else rest
        for pid in PLANNING_ID.finditer(clause):
            refs.append(f"{pid.group(1)}-{pid.group(2)}")
        for ref in ISSUE_REF.finditer(clause):
            refs.append(f"#{ref.group(1)}")
    seen: set[str] = set()
    return [r for r in refs if not (r in seen or seen.add(r))]


def parent_ref(body: str) -> int | None:
    match = PARENT_REF.search(body)
    return int(match.group(1)) if match else None


def body_complete(body: str) -> bool:
    parts = sections(body)
    return all(parts.get(name, "").strip() for name in SECTIONS)


def _focus_text(issue: dict) -> str:
    parts = sections(issue["body"])
    return "\n".join([issue["title"], parts.get("Outcome", ""), parts.get("Scope", "")])


# --- derivation -----------------------------------------------------------------------

def _validated(field: str, value: str | None, rule: str, options: dict[str, list[str]]):
    if value is None:
        return None, rule
    live = options.get(field)
    if live is not None and value not in live:
        return None, f"{rule}; no live option named {value!r} (options: {', '.join(live)})"
    return value, rule


def derive_area(issue: dict) -> tuple[str | None, str]:
    if issue["sub_issues"]:
        return None, "a parent spanning several areas may leave Area unset"
    text = _focus_text(issue)
    scores = {
        area: sum(len(re.findall(pattern, text)) for pattern in patterns)
        for area, patterns in AREA_KEYWORDS.items()
    }
    ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
    top, runner = ranked[0], ranked[1]
    if top[1] >= 2 and top[1] > runner[1]:
        return top[0], f"keywords in title/Outcome/Scope score {top[0]} {top[1]} vs {runner[0]} {runner[1]}"
    return None, f"ambiguous: {top[0]} {top[1]} vs {runner[0]} {runner[1]}; choose by hand"


def derive_role(issue: dict) -> tuple[str | None, str]:
    if issue["sub_issues"]:
        return None, "a parent whose sub-issues carry their own roles may leave Owning role unset"
    if "decision-needed" in issue["labels"]:
        return "Owner", "decision-needed label: only an owner ruling unblocks it"
    if "research" in issue["labels"]:
        return "Research", "research label: discovery work, no code"
    hits = sorted({RISK_AREA_FAMILY.get(m.group(1).lower()[:6], m.group(1).lower()) for m in RISK_AREA.finditer(_focus_text(issue))})
    if len(hits) >= 2:
        return "Escalation", "risk areas named in title/Outcome/Scope: " + ", ".join(hits)
    if hits:
        return None, f"ambiguous: one risk-area mention ({hits[0]}) in title/Outcome/Scope; Builder or Escalation is the parent's call"
    return "Builder", "no risk area named; the default worker for a bounded slice"


def derive(field: str, issue: dict, batch: dict[int, dict], options: dict[str, list[str]]):
    """(suggested value or None, the rule that produced it)."""
    pid = planning_id(issue["title"])
    parent = batch.get(issue["parent"]) if issue.get("parent") else None
    open_blockers = [b["number"] for b in issue["blocked_by"] if b["state"] == "OPEN"]
    open_children = [s["number"] for s in issue["sub_issues"] if s["state"] == "OPEN"]

    if field == "Status":
        if issue["state"] != "OPEN":
            return None, "closed issue: Done is the owner's acceptance call, never derived"
        if open_children:
            value, rule = "Todo", "a parent with open sub-issues is worked through its children"
        elif open_blockers:
            value, rule = WAITING, "open native blockers: " + ", ".join(f"#{n}" for n in open_blockers)
        elif "decision-needed" in issue["labels"]:
            value, rule = DECISION, "decision-needed label: waiting on an owner ruling"
        elif body_complete(issue["body"]):
            value, rule = "Ready", "no open blockers and a complete body"
        else:
            value, rule = "Todo", "no open blockers but the body is incomplete"
        return _validated(field, value, rule, options)

    if field == "Horizon":
        if parent and parent["fields"].get("Horizon"):
            return _validated(field, parent["fields"]["Horizon"], f"inherited from parent #{parent['number']}", options)
        if pid:
            return _validated(field, HORIZON_BY_PREFIX.get(pid[:4]), f"planning ID {pid}", options)
        return None, "no parent value and no planning ID in the title"

    if field == "Phase":
        if parent and parent["fields"].get("Phase"):
            return _validated(field, parent["fields"]["Phase"], f"inherited from parent #{parent['number']}", options)
        if pid:
            value = PHASE_BY_PLANNING_ID.get(pid) or PHASE_BY_PLANNING_ID.get(pid[:4])
            return _validated(field, value, f"planning ID {pid}", options)
        return None, "no parent value and no planning ID in the title"

    if field == "Area":
        value, rule = derive_area(issue)
        return _validated(field, value, rule, options)

    if field == "Priority":
        blocks = [b["number"] for b in issue["blocking"] if b["number"] in batch and b["state"] == "OPEN"]
        if len(blocks) >= 2:
            return _validated(field, "High", "blocks " + ", ".join(f"#{n}" for n in blocks) + " in this batch", options)
        return _validated(field, "Normal", "default; Critical is never derived", options)

    if field == "Size":
        if issue["sub_issues"]:
            return None, "a parent carries no Size; its sub-issues do"
        return None, SIZE_RULE

    if field == "Owning role":
        value, rule = derive_role(issue)
        return _validated(field, value, rule, options)

    return None, f"no derivation rule for {field}"


# --- the audit ------------------------------------------------------------------------

def _slug(field: str) -> str:
    return field.lower().replace(" ", "-")


def audit(batch: dict[int, dict], options: dict[str, list[str]], parent_arg: int | None = None) -> dict:
    planning: dict[str, list[int]] = {}
    for n, issue in batch.items():
        pid = planning_id(issue["title"])
        if pid:
            planning.setdefault(pid, []).append(n)

    batch_findings: list[dict] = []
    for pid, numbers in sorted(planning.items()):
        if len(numbers) > 1:
            batch_findings.append({
                "code": f"duplicate-planning-id:{pid}", "severity": "finding", "fixable": False,
                "detail": "carried by " + ", ".join(f"#{n}" for n in numbers) + "; one of them is a twin",
            })

    reports = []
    for n in sorted(batch):
        issue = batch[n]
        findings: list[dict] = []

        def add(code, severity, *, fixable=False, suggestion=None, rule=None, fix=None, detail=None):
            entry = {"code": code, "severity": severity, "fixable": fixable}
            if suggestion is not None:
                entry["suggestion"] = suggestion
            if rule:
                entry["rule"] = rule
            if fix:
                entry["fix"] = fix
            if detail:
                entry["detail"] = detail
            findings.append(entry)

        if not issue["on_board"]:
            add("not-on-board", "finding", fixable=True, fix=f"{BOARD_SET} {n}",
                detail="no item on the configured project; board-set.sh adds it")

        for field in CLASSIFICATION:
            current = issue["fields"].get(field)
            suggestion, rule = derive(field, issue, batch, options)
            if current is None:
                if field in PARENT_OPTIONAL and issue["sub_issues"]:
                    add(f"{_slug(field)}-unset-on-parent", "info", rule=rule)
                    continue
                fix = f'{BOARD_SET} {n} "{field}" "{suggestion}"' if suggestion else None
                add(f"missing-field:{field}", "finding", fixable=bool(suggestion), suggestion=suggestion, rule=rule, fix=fix)
            elif field in ("Horizon", "Phase") and suggestion and current != suggestion:
                add(f"field-vs-derivation:{field}", "info", suggestion=suggestion, rule=rule,
                    detail=f"set to {current!r}; left as set — reclassify only on the parent's instruction")

        status = issue["fields"].get("Status")
        if status in EVIDENCE_STATUSES and not issue["fields"].get("Evidence"):
            add("missing-field:Evidence", "finding",
                rule="the PR, CI run, replay report, or eval-output pointer that justified this Status",
                detail=f'set it with {BOARD_SET} {n} Evidence "<url or pointer>" once known')

        for label in issue["labels"]:
            if label not in TAXONOMY:
                add(f"label-outside-taxonomy:{label}", "finding",
                    detail="not in the file-issue.sh taxonomy; report it, never remove a label")

        parts = sections(issue["body"])
        for name in SECTIONS:
            if name not in parts:
                add(f"body-section-missing:{name}", "finding", detail="vigil-docs owns the body; report to the parent")
            elif not parts[name].strip():
                add(f"body-section-empty:{name}", "finding", detail="vigil-docs owns the body; report to the parent")

        native = {b["number"]: b for b in issue["blocked_by"]}
        named: set[int] = set()
        for ref in blocker_refs(parts.get("Dependencies", "")):
            if ref.startswith("#"):
                target = int(ref[1:])
            else:
                numbers = planning[ref] if ref in planning else []
                if len(numbers) != 1:
                    add(f"body-blocker-unresolved:{ref}", "finding",
                        detail="no single issue in this batch carries that planning ID; pass the batch it belongs to")
                    continue
                target = numbers[0]
            named.add(target)
            if target == n:
                add(f"body-blocker-self:{ref}", "finding", detail="an issue cannot block itself")
            elif target not in native:
                add(f"body-blocker-unlinked:#{target}", "finding", fixable=True,
                    fix=f"{FILE_ISSUE} --issue {n} --blocked-by {target}",
                    detail=f"the body names {ref} as a blocker but no native blocked-by link exists")
        dependencies = parts.get("Dependencies", "")
        for number in native:
            target_pid = planning_id(batch[number]["title"]) if number in batch else None
            mentioned = f"#{number}" in dependencies or (target_pid is not None and target_pid in dependencies)
            if number not in named and not mentioned:
                add(f"native-blocker-unnamed:#{number}", "info",
                    detail="linked natively but the Dependencies section never names it")

        wanted_parent = parent_ref(issue["body"])
        if wanted_parent is None and parent_arg is not None and n != parent_arg:
            wanted_parent = parent_arg
        if wanted_parent is not None and wanted_parent != n and issue["parent"] != wanted_parent:
            add(f"parent-unlinked:#{wanted_parent}", "finding", fixable=True,
                fix=f"{FILE_ISSUE} --issue {n} --parent {wanted_parent}",
                detail=f"expected parent #{wanted_parent}, native parent is "
                       + (f"#{issue['parent']}" if issue["parent"] else "none"))

        open_blockers = [b["number"] for b in issue["blocked_by"] if b["state"] == "OPEN"]
        open_children = [s["number"] for s in issue["sub_issues"] if s["state"] == "OPEN"]
        blocker_list = ", ".join(f"#{b}" for b in open_blockers)
        if status in ("Todo", "Ready") and open_blockers and not open_children:
            add("status-vs-blockers", "finding", fixable=True, suggestion=WAITING,
                fix=f'{BOARD_SET} {n} Status "{WAITING}"',
                detail=f"{status} while natively blocked by open {blocker_list}")
        if status == WAITING and not open_blockers and issue["state"] == "OPEN":
            resolved = "Ready" if body_complete(issue["body"]) else "Todo"
            add("waiting-without-open-blocker", "finding", fixable=True, suggestion=resolved,
                fix=f"{BOARD_SET} {n} Status {resolved}",
                detail="every native blocker is closed or none exists")
        if (status == "Todo" and issue["state"] == "OPEN" and not open_blockers and not open_children
                and body_complete(issue["body"]) and "decision-needed" not in issue["labels"]):
            add("todo-but-unblocked", "info", suggestion="Ready",
                detail="no open blockers and a complete body; Ready if the parent agrees")
        if status == DECISION and "decision-needed" not in issue["labels"]:
            add("needs-decision-without-label", "info", detail="Needs decision but no decision-needed label")
        if status not in (DECISION, "Done") and "decision-needed" in issue["labels"] and issue["state"] == "OPEN":
            add("decision-label-outside-needs-decision", "info", suggestion=DECISION,
                detail="decision-needed label while Status is " + (status or "unset"))
        if status == "Done" and issue["state"] == "OPEN":
            add("done-but-open", "finding", detail="Done on an open issue; acceptance is the owner's call, report only")
        if issue["state"] != "OPEN" and status != "Done":
            add("closed-not-done", "info", detail="closed but not Done; only verified acceptance moves it")

        owner_turn = status in ("In review", DECISION)
        if issue["assignees"] and not owner_turn:
            add("assigned-outside-owner-turn", "finding",
                detail="assigned to " + ", ".join(issue["assignees"]) + " while the next action is not the owner's; "
                       f"the parent decides — `{BOARD_SET} {n} --unassign` only with its authorization")
        if owner_turn and not issue["assignees"]:
            add("owner-turn-unassigned", "finding", fixable=True, fix=f"{BOARD_SET} {n} --assign",
                detail=f"{status} means the next action is the owner's, so the owner is assigned")

        reports.append({
            "number": n,
            "title": issue["title"],
            "planning_id": planning_id(issue["title"]),
            "state": issue["state"],
            "on_board": issue["on_board"],
            "fields": issue["fields"],
            "labels": issue["labels"],
            "assignees": issue["assignees"],
            "parent": issue["parent"],
            "sub_issues": [s["number"] for s in issue["sub_issues"]],
            "blocked_by": [b["number"] for b in issue["blocked_by"]],
            "findings": findings,
        })

    all_findings = [f for r in reports for f in r["findings"]] + batch_findings
    summary = {
        "issues": len(reports),
        "findings": sum(1 for f in all_findings if f["severity"] == "finding"),
        "fixable": sum(1 for f in all_findings if f["severity"] == "finding" and f["fixable"]),
        "info": sum(1 for f in all_findings if f["severity"] == "info"),
    }
    return {"issues": reports, "batch_findings": batch_findings, "summary": summary}


# --- rendering ------------------------------------------------------------------------

def render(report: dict) -> str:
    lines = []
    for issue in report["issues"]:
        fields = " ".join(f"{f}={issue['fields'].get(f) or '-'}" for f in CLASSIFICATION)
        lines.append(
            f"#{issue['number']}  {issue['title']}  [{issue['state']}]"
            + ("" if issue["on_board"] else "  NOT ON BOARD")
        )
        lines.append(f"    {fields}")
        lines.append(
            "    labels=" + (",".join(issue["labels"]) or "-")
            + "  assignees=" + (",".join(issue["assignees"]) or "-")
            + "  parent=" + (f"#{issue['parent']}" if issue["parent"] else "-")
            + "  blocked_by=" + (",".join(f"#{n}" for n in issue["blocked_by"]) or "-")
            + ("  sub_issues=" + ",".join(f"#{n}" for n in issue["sub_issues"]) if issue["sub_issues"] else "")
            + (f"  evidence={issue['fields']['Evidence']}" if issue["fields"].get("Evidence") else "")
        )
        for finding in issue["findings"]:
            lines.append(_render_finding(finding))
    for finding in report["batch_findings"]:
        lines.append(_render_finding(finding, prefix="batch"))
    s = report["summary"]
    lines.append(f"{s['issues']} issues, {s['findings']} findings ({s['fixable']} fixable), {s['info']} info")
    return "\n".join(lines)


def _render_finding(finding: dict, prefix: str = "   ") -> str:
    text = f"{prefix} {finding['severity']:<8}{finding['code']}"
    if finding.get("suggestion"):
        text += f"  → {finding['suggestion']!r}"
    if finding.get("rule"):
        text += f"  ({finding['rule']})"
    if finding.get("detail"):
        text += f"  {finding['detail']}"
    if finding.get("fix"):
        text += f"\n{prefix}         fix: {finding['fix']}"
    return text


# --- entry point ----------------------------------------------------------------------

def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("numbers", nargs="*", type=int, help="issue numbers to audit")
    parser.add_argument("--parent", type=int, help="audit this issue and every sub-issue")
    parser.add_argument("--since", help="audit every issue created at or after this ISO-8601 timestamp")
    parser.add_argument("--json", action="store_true", help="print the report as JSON")
    args = parser.parse_args(argv)
    if not args.numbers and args.parent is None and not args.since:
        parser.error("give issue numbers, --parent N, or --since TIMESTAMP")
    return args


def main(argv: list[str] | None = None) -> int:
    try:
        args = parse_args(sys.argv[1:] if argv is None else argv)
    except SystemExit as exc:  # argparse exits 2; the helpers use 64 for usage
        return EXIT_USAGE if exc.code else 0

    env_path = Path(os.environ.get("VIGIL_BOARD_ENV") or DEFAULT_ENV)
    if not env_path.is_file():
        print(f"not configured: {env_path} does not exist", file=sys.stderr)
        return EXIT_UNCONFIGURED
    values = load_env(env_path)
    owner = require(values, "VIGIL_BOARD_OWNER", env_path)
    repo = require(values, "VIGIL_BOARD_REPO", env_path)
    project_id = require(values, "VIGIL_BOARD_PROJECT_ID", env_path)
    require(values, "VIGIL_BOARD_ASSIGNEE", env_path)
    name = repo.split("/", 1)[1] if "/" in repo else repo

    try:
        numbers = set(args.numbers)
        if args.since:
            numbers.update(fetch_since(repo, args.since))
        if args.parent is not None:
            numbers.add(args.parent)
            parent_node = fetch_issues(owner, name, [args.parent])[args.parent]
            numbers.update(s["number"] for s in parent_node["subIssues"]["nodes"])
        ordered = sorted(numbers)
        nodes = fetch_issues(owner, name, ordered)
        options = fetch_fields(project_id)
    except ApiError as exc:
        print(f"GitHub API failure: {exc}", file=sys.stderr)
        return EXIT_API

    batch = {n: snapshot(nodes[n], project_id) for n in ordered}
    report = audit(batch, options, parent_arg=args.parent)
    report["repo"] = repo
    report["project_id"] = project_id
    print(json.dumps(report, indent=2) if args.json else render(report))
    return EXIT_FINDINGS if report["summary"]["findings"] else EXIT_CLEAN


if __name__ == "__main__":
    sys.exit(main())
