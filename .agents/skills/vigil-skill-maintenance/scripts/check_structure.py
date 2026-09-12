#!/usr/bin/env python3
"""Read-only, deliberately limited structural checks for repository skills."""

import argparse
import json
import re
from pathlib import Path



def check(repo, names):
    root = repo / ".agents/skills"
    issues = []

    def issue(code, path, detail):
        issues.append({"code": code, "path": str(path), "detail": detail})

    if not root.is_dir():
        issue("missing-root", root, "Canonical skill root is missing.")
    if not names and root.is_dir():
        names = sorted(p.name for p in root.iterdir() if p.is_dir() or p.is_symlink())
    for name in names:
        skill = root / name
        if skill.is_symlink() or not skill.is_dir():
            issue("canonical-directory", skill, "Expected a real canonical directory.")
            continue
        for required in ("SKILL.md", "agents/openai.yaml"):
            if not (skill / required).is_file():
                issue("missing-resource", skill / required, "Required skill file is missing.")
        alias = repo / ".claude/skills" / name
        if not alias.is_symlink() and not alias.exists():
            # Expected until the parent creates compatibility symlinks after a
            # skill's canonical directory and required files exist.
            issue("missing-compatibility-link", alias,
                  "Compatibility symlink does not exist yet.")
        else:
            try:
                if not alias.is_symlink() or alias.resolve(strict=True) != skill.resolve(strict=True):
                    issue("compatibility-link", alias, "Expected a symlink to the canonical skill.")
            except (OSError, RuntimeError):
                issue("compatibility-link", alias, "Compatibility link is dangling or cyclic.")
    return {
        "scope": "structural", "passed": not issues, "skills": names, "issues": issues,
        "unverified": ["YAML schema", "reference paths and Markdown links", "runtime discovery",
                       "tool availability and hook attachment", "routing and helper behavior"],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("names", nargs="*", help="Skill names; omit to check all repository skills")
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[4])
    args = parser.parse_args()
    if any(not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name) for name in args.names):
        parser.error("Use skill names, not paths.")
    try:
        report = check(args.repo.resolve(), args.names)
    except OSError as error:
        parser.error(str(error))
    print(json.dumps(report, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
