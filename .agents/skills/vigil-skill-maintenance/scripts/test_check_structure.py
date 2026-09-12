"""Offline fixtures; no application or service imports."""

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("check_structure", Path(__file__).with_name("check_structure.py"))
CHECKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECKER)


class StructureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        self.skill = self.create_skill("sample")

    def create_skill(self, name, alias=True):
        skill = self.repo / ".agents/skills" / name
        (skill / "agents").mkdir(parents=True)
        (skill / "SKILL.md").write_text("# Sample\n", encoding="utf-8")
        (skill / "agents/openai.yaml").write_text("interface: {}\n", encoding="utf-8")
        if alias:
            link = self.repo / ".claude/skills" / name
            link.parent.mkdir(parents=True, exist_ok=True)
            link.symlink_to(Path("../../.agents/skills") / name)
        return skill

    def codes(self, names=None):
        return [item["code"] for item in CHECKER.check(self.repo, names or [])["issues"]]

    def test_valid_structure_leaves_yaml_and_runtime_unverified(self):
        report = CHECKER.check(self.repo, [])
        self.assertTrue(report["passed"])
        self.assertIn("YAML schema", report["unverified"])
        self.assertIn("runtime discovery", report["unverified"])

    def test_required_file_missing(self):
        (self.skill / "agents/openai.yaml").unlink()
        self.assertEqual(self.codes(), ["missing-resource"])

    def test_missing_alias_reported_as_missing_compatibility_link(self):
        # The parent creates .claude/skills compatibility symlinks after a
        # skill's canonical directory and required files exist, so a skill
        # with none yet must not be confused with a broken/wrong-target link.
        self.create_skill("unlinked", alias=False)
        self.assertEqual(self.codes(["unlinked"]), ["missing-compatibility-link"])
        # An already-linked skill is unaffected.
        self.assertEqual(self.codes(["sample"]), [])

    def test_alias_must_target_own_skill(self):
        self.create_skill("other")
        alias = self.repo / ".claude/skills/sample"
        alias.unlink()
        alias.symlink_to("../../.agents/skills/other")
        self.assertEqual(self.codes(), ["compatibility-link"])

    def test_dangling_alias(self):
        alias = self.repo / ".claude/skills/sample"
        alias.unlink()
        alias.symlink_to("absent")
        self.assertEqual(self.codes(), ["compatibility-link"])

    def test_scoped_check_ignores_unrelated_skill(self):
        other = self.create_skill("other")
        (other / "SKILL.md").unlink()
        self.assertEqual(self.codes(["sample"]), [])
        self.assertEqual(self.codes(), ["missing-resource"])

    def test_canonical_directory_cannot_be_alias(self):
        self.create_skill("other")
        (self.repo / ".agents/skills/linked").symlink_to("other")
        self.assertEqual(self.codes(), ["canonical-directory"])

    def cli(self, *names):
        return subprocess.run(
            [sys.executable, '-B', str(Path(__file__).with_name('check_structure.py')),
             '--repo', str(self.repo), *names], capture_output=True, text=True)

    def test_cli_pass_emits_json_and_zero(self):
        result = self.cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)['passed'])

    def test_cli_failure_emits_json_and_nonzero(self):
        (self.skill / 'SKILL.md').unlink()
        result = self.cli('sample')
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertFalse(json.loads(result.stdout)['passed'])

    def test_cli_rejects_path_argument(self):
        result = self.cli('../sample')
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, '')


if __name__ == "__main__":
    unittest.main()
