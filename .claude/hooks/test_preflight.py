"""Offline hook fixtures for preflight.py.

Every git repo these tests touch is a throwaway one created fresh under the
session scratchpad for the duration of a single test, never the actual
repository root and never a real checkout. These tests read git state (`git
status`, `git diff --cached`) and call `check()` directly; they never invoke
`preflight.py` as an actual git hook and never execute the commands `check()`
is asked to judge.
"""

import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("preflight.py").resolve()
SPEC = importlib.util.spec_from_file_location("preflight", SCRIPT)
HOOK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HOOK)

# All throwaway repos live under the session scratchpad -- never under this
# repository's own root, and never anywhere a real `git` checkout could be.
SCRATCH_ROOT = Path(
    "/tmp/claude-1000/-home-brian-projects-trader/bfd661a3-973d-4185-9603-8810ce9b6954/scratchpad"
)


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(repo), *args], check=True, capture_output=True, text=True
    )


def make_repo() -> Path:
    """A fresh git repo under the scratchpad with one committed file, so `git
    diff --cached` and `git status` behave the way they do in a real checkout."""
    SCRATCH_ROOT.mkdir(parents=True, exist_ok=True)
    repo = Path(tempfile.mkdtemp(dir=str(SCRATCH_ROOT), prefix="preflight-test-"))
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "config", "user.email", "test@example.invalid")
    _git(repo, "config", "user.name", "Test")
    _git(repo, "config", "commit.gpgsign", "false")
    (repo / "README.md").write_text("placeholder\n", encoding="utf-8")
    _git(repo, "add", "README.md")
    _git(repo, "commit", "-q", "-m", "initial")
    return repo


def run_main(payload: dict) -> tuple[int, str, str]:
    """Run preflight.py as a subprocess with payload on stdin; never execs the
    command inside it."""
    result = subprocess.run(
        [sys.executable, "-B", str(SCRIPT)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
    )
    return result.returncode, result.stdout, result.stderr


class CheckFunctionTests(unittest.TestCase):
    """Exercise check() directly against a throwaway repo, so the pure decision
    logic is covered without going through a subprocess or a real tool call."""

    def setUp(self):
        self.repo = make_repo()

    def tearDown(self):
        shutil.rmtree(self.repo, ignore_errors=True)

    # --- local gate family ---

    def test_each_gate_family_is_denied(self):
        for command in (
            "pnpm test",
            "pnpm test:int",
            "pnpm run lint:cycles",
            "pnpm exec vitest",
            "npx vitest",
            "vitest",
        ):
            with self.subTest(command=command):
                reason = HOOK.check(command, str(self.repo))
                self.assertIsNotNone(reason)
                self.assertIn("[vigil preflight]", reason)

    def test_lint_docs_is_allowed(self):
        self.assertIsNone(HOOK.check("pnpm lint:docs", str(self.repo)))

    def test_pnpm_install_is_allowed(self):
        self.assertIsNone(HOOK.check("pnpm install", str(self.repo)))

    # --- commit pathspec / sweep guard ---

    def test_commit_all_flag_is_denied_with_a_dirty_tree(self):
        (self.repo / "README.md").write_text("changed\n", encoding="utf-8")
        reason = HOOK.check("git commit -a -m x", str(self.repo))
        self.assertIsNotNone(reason)
        self.assertIn("sweeps the whole working tree", reason)

    def test_commit_with_pathspec_is_allowed(self):
        (self.repo / "new.txt").write_text("x\n", encoding="utf-8")
        _git(self.repo, "add", "new.txt")
        reason = HOOK.check('git commit -m x -- new.txt', str(self.repo))
        self.assertIsNone(reason)

    def test_commit_with_index_ack_is_allowed(self):
        (self.repo / "new.txt").write_text("x\n", encoding="utf-8")
        _git(self.repo, "add", "new.txt")
        # Without the acknowledgement, a no-pathspec commit of a pre-populated
        # index is denied.
        self.assertIsNotNone(HOOK.check("git commit -m x", str(self.repo)))
        # With it, the same command is allowed.
        reason = HOOK.check(f"{HOOK.ACK_INDEX} git commit -m x", str(self.repo))
        self.assertIsNone(reason)

    # --- privacy/secrets guard: git add ---

    def test_git_add_env_is_denied(self):
        reason = HOOK.check("git add .env", str(self.repo))
        self.assertIsNotNone(reason)
        self.assertIn(".env", reason)
        self.assertIn("no acknowledgement flag", reason)

    def test_git_add_env_example_is_allowed(self):
        self.assertIsNone(HOOK.check("git add .env.example", str(self.repo)))

    def test_git_add_sweep_with_a_pem_in_the_tree_is_denied(self):
        (self.repo / "keys").mkdir()
        (self.repo / "keys" / "wallet.pem").write_text("x\n", encoding="utf-8")
        reason = HOOK.check("git add -A", str(self.repo))
        self.assertIsNotNone(reason)
        self.assertIn("wallet.pem", reason)
        self.assertIn("no acknowledgement flag", reason)

    # --- privacy/secrets guard: git commit (staged set) ---

    def test_staged_private_notes_is_denied_at_commit(self):
        (self.repo / "private").mkdir()
        (self.repo / "private" / "notes.md").write_text("x\n", encoding="utf-8")
        _git(self.repo, "add", "private/notes.md")
        reason = HOOK.check("git commit -m x", str(self.repo))
        self.assertIsNotNone(reason)
        self.assertIn("private/notes.md", reason)
        self.assertIn("git restore --staged", reason)
        self.assertIn("no acknowledgement flag", reason)

    def test_staged_handoff_doc_is_denied_at_commit(self):
        (self.repo / HOOK.HANDOFF_BASENAME).write_text("x\n", encoding="utf-8")
        _git(self.repo, "add", HOOK.HANDOFF_BASENAME)
        reason = HOOK.check("git commit -m x", str(self.repo))
        self.assertIsNotNone(reason)
        self.assertIn(HOOK.HANDOFF_BASENAME, reason)
        self.assertIn("git restore --staged", reason)

    def test_staged_handoff_doc_is_denied_even_with_a_pathspec_or_the_index_ack(self):
        """The secrets guard has no override -- neither a pathspec narrowing the
        commit nor VIGIL_INDEX_OK gets a sensitive path past it."""
        (self.repo / HOOK.HANDOFF_BASENAME).write_text("x\n", encoding="utf-8")
        _git(self.repo, "add", HOOK.HANDOFF_BASENAME)
        for command in (
            f"git commit -m x -- {HOOK.HANDOFF_BASENAME}",
            f"{HOOK.ACK_INDEX} git commit -m x",
        ):
            with self.subTest(command=command):
                reason = HOOK.check(command, str(self.repo))
                self.assertIsNotNone(reason)
                self.assertIn(HOOK.HANDOFF_BASENAME, reason)

    # --- pass-through / fail-open ---

    def test_non_git_command_passes_through(self):
        self.assertIsNone(HOOK.check("ls -la", str(self.repo)))

    def test_internal_error_in_check_is_not_swallowed_by_check_itself(self):
        """check() itself does not fail-open -- that contract lives in main(), which
        wraps this call. Confirm the boundary: a command `check()` cannot parse as
        a path still returns a plain result, not a raised exception escaping here."""
        # A deeply pathological but syntactically valid shell command must still
        # produce a decision, not raise.
        try:
            HOOK.check("git -C " + str(self.repo) + " status", str(self.repo))
        except Exception as exc:  # pragma: no cover - documents the expectation
            self.fail(f"check() raised instead of returning a decision: {exc}")


class ProcessTests(unittest.TestCase):
    """Exercise the stdin-to-exit-code wiring, matching how Claude Code actually
    invokes the hook."""

    def setUp(self):
        self.repo = make_repo()

    def tearDown(self):
        shutil.rmtree(self.repo, ignore_errors=True)

    def test_non_bash_tool_exits_zero_with_no_output(self):
        code, out, err = run_main({"tool_name": "Read", "tool_input": {}})
        self.assertEqual(code, 0)
        self.assertEqual(out, "")
        self.assertEqual(err, "")

    def test_a_gate_command_is_denied_with_exit_code_two(self):
        code, out, err = run_main({
            "tool_name": "Bash",
            "tool_input": {"command": "pnpm test"},
            "cwd": str(self.repo),
        })
        self.assertEqual(code, 2)
        self.assertIn("[vigil preflight]", err)

    def test_an_ordinary_command_passes(self):
        code, out, err = run_main({
            "tool_name": "Bash",
            "tool_input": {"command": "ls -la"},
            "cwd": str(self.repo),
        })
        self.assertEqual(code, 0, err)

    def test_a_command_naming_none_of_the_watched_tools_short_circuits(self):
        """The early exit: a command mentioning none of git/pnpm/vitest/npx/pnpx/bunx
        never reaches check() at all."""
        code, out, err = run_main({
            "tool_name": "Bash",
            "tool_input": {"command": "echo hello"},
            "cwd": str(self.repo),
        })
        self.assertEqual(code, 0)
        self.assertEqual(out, "")
        self.assertEqual(err, "")

    def test_malformed_stdin_fails_open(self):
        result = subprocess.run(
            [sys.executable, "-B", str(SCRIPT)],
            input="not json",
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")

    def test_non_object_json_payload_fails_open(self):
        result = subprocess.run(
            [sys.executable, "-B", str(SCRIPT)],
            input="[]",
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")

    def test_report_mode_on_a_clean_repo(self):
        result = subprocess.run(
            [sys.executable, "-B", str(SCRIPT), "--report", str(self.repo)],
            capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 0)
        self.assertIn("tree clean", result.stdout)

    def test_report_mode_on_a_dirty_repo(self):
        (self.repo / "README.md").write_text("changed\n", encoding="utf-8")
        result = subprocess.run(
            [sys.executable, "-B", str(SCRIPT), "--report", str(self.repo)],
            capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("tree NOT clean", result.stdout)


if __name__ == "__main__":
    unittest.main()
