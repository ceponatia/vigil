#!/usr/bin/env python3
"""PreToolUse hook for Bash: the vigil commit and local-gate preflight.

Two hazards this hook guards against:

* A local application gate (`pnpm test`, `pnpm lint` other than `pnpm
  lint:docs`, `pnpm typecheck`, `pnpm build`, or any form of Vitest) run on
  this machine instead of GitHub Actions CI, silently diverging from the
  gate a pull request actually runs against.
* `git commit` with no pathspec, which commits the whole index. Sessions
  share checkouts and stage files mid-task; an unscoped commit sweeps in
  someone else's in-progress work along with your own.

A third guard carries no acknowledgement override: staging or committing an
env file, the private design handoff, anything under `private/`, `data/`,
or `eval-output/`, `.claude/settings.local.json`, or a path that looks like
a private key, keystore, seed, or mnemonic file. Money and credentials must
never enter git history by accident, so there is no override flag for this
one — unstage the path instead.

The hook never blocks on its own failure: any internal error exits 0
(fail open).

Acknowledgement, when you have looked and mean it:
  VIGIL_INDEX_OK=1 git commit -m … …        commit a pre-populated index

A deploy preflight for the eventual hosting target is added once hosting is
chosen; none exists yet, so this hook only guards commits and local gates.

Manual report:  python3 .claude/hooks/preflight.py --report [dir]
"""
from __future__ import annotations

import fnmatch
import json
import os
import re
import shlex
import subprocess
import sys

ACK_INDEX = "VIGIL_INDEX_OK=1"
# Local gate runs are an owner ruling: GitHub Actions CI is the required gate
# for this repository, not this machine. The settings deny list catches the
# bare families; this catches every `pnpm test:*` / `pnpm lint:*` sub-script,
# `pnpm run …`, and a bare or runner-launched Vitest, which the deny syntax
# (space-star prefixes only) cannot express.
GATE_SCRIPT = re.compile(r"^(test|lint|typecheck|verify|vitest)(?::[\w.-]+)?$")
GATE_ALLOWED = {"lint:docs"}  # sanctioned for documentation-only changes (AGENTS.md)
PNPM_PASSTHROUGH = {"run", "exec", "dlx", "-r", "--recursive", "-w", "--workspace-root", "--stream", "--parallel"}
RUNNERS = {"npx", "pnpx", "bunx"}  # `npx vitest …` is a local Vitest run too
SEPARATORS = {"&&", "||", ";", "|", "&"}
COMMIT_VALUE_OPTS = {
    "-m", "--message", "-F", "--file", "-C", "--reuse-message", "-c",
    "--reedit-message", "--author", "--date", "-t", "--template", "--trailer",
    "--fixup", "--squash", "--cleanup", "--pathspec-from-file", "-S", "--gpg-sign",
}
SWEEP_ADD = {"-A", "--all", ".", ":/", "-u", "--update", "--no-ignore-removal"}
LIMIT = 30

# The privacy/secrets guard: paths that must never be staged or committed, no
# matter what. `.env.example` is the one `.env*` name that is meant to be
# committed; everything else in this list is either a live credential shape
# or one of this repo's gitignored, personal-data-bearing directories.
SENSITIVE_DIRS = {"private", "data", "eval-output"}
HANDOFF_BASENAME = "Crypto_Trading_Repo_Project_Handoff.md"
LOCAL_SETTINGS = ".claude/settings.local.json"
SENSITIVE_BASENAME_GLOBS = (
    "*.pem", "*.key", "*.p12", "*.keystore",
    "id_rsa*", "id_ed25519*", "seed*", "mnemonic*", "*.secret",
)


def git(cwd: str, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", cwd, *args], capture_output=True, text=True, timeout=15
    ).stdout.rstrip("\n")


def is_repo(cwd: str) -> bool:
    r = subprocess.run(["git", "-C", cwd, "rev-parse", "--show-toplevel"],
                       capture_output=True, text=True, timeout=15)
    return r.returncode == 0


def tokenize(command: str) -> list[str]:
    lex = shlex.shlex(command, posix=True, punctuation_chars=True)
    lex.whitespace_split = True
    return list(lex)


def segments(tokens: list[str]) -> list[list[str]]:
    out: list[list[str]] = []
    cur: list[str] = []
    for t in tokens:
        if t in SEPARATORS or set(t) <= set("&|;"):
            if cur:
                out.append(cur)
            cur = []
        else:
            cur.append(t)
    if cur:
        out.append(cur)
    return out


def strip_env_prefix(seg: list[str]) -> list[str]:
    i = 0
    if seg and seg[0] == "env":
        i = 1
    while i < len(seg) and "=" in seg[i] and not seg[i].startswith("-"):
        i += 1
    return seg[i:]


def resolve(base: str, path: str) -> str:
    path = os.path.expanduser(path)
    return os.path.normpath(path if os.path.isabs(path) else os.path.join(base, path))


def tree_report(cwd: str) -> tuple[bool, str]:
    """(clean, text). Clean means nothing modified or untracked. A generic checkout
    status, useful before any sensitive operation; not tied to a specific deploy target."""
    if not is_repo(cwd):
        return True, f"{cwd} is not a git checkout — nothing to check"
    branch = git(cwd, "branch", "--show-current") or "(detached)"
    head = git(cwd, "rev-parse", "--short", "HEAD")
    status = git(cwd, "status", "--porcelain", "--untracked-files=normal")
    lines = status.splitlines()
    rel = ""
    try:
        lr = git(cwd, "rev-list", "--left-right", "--count", "origin/main...HEAD")
        behind, ahead = lr.split()
        rel = f", {ahead} ahead / {behind} behind origin/main"
    except Exception:
        pass
    head_line = f"{cwd}: branch {branch} @ {head}{rel}"
    if not lines:
        return True, f"{head_line}, tree clean"
    shown = "\n".join("  " + l for l in lines[:LIMIT])
    more = f"\n  … and {len(lines) - LIMIT} more" if len(lines) > LIMIT else ""
    return False, f"{head_line}, tree NOT clean ({len(lines)} entries):\n{shown}{more}"


def status_paths(cwd: str) -> list[str]:
    """Working-tree paths from `git status --porcelain`, renames resolved to their
    new name and quoting stripped."""
    out = []
    for line in git(cwd, "status", "--porcelain", "--untracked-files=all").splitlines():
        if len(line) < 4:
            continue
        p = line[3:]
        if " -> " in p:
            p = p.split(" -> ", 1)[1]
        if len(p) >= 2 and p[0] == '"' and p[-1] == '"':
            p = p[1:-1]
        out.append(p)
    return out


def is_sensitive(raw_path: str) -> str | None:
    """Return why `raw_path` must never be staged or committed, or None when it's fine."""
    p = raw_path.strip()
    if len(p) >= 2 and p[0] == '"' and p[-1] == '"':
        p = p[1:-1]
    if p.startswith("./"):
        p = p[2:]
    p = p.replace(os.sep, "/")
    base = p.rsplit("/", 1)[-1] or p
    parts = [seg for seg in p.split("/") if seg not in ("", ".")]

    if base == ".env.example":
        return None
    if base == ".env" or base.startswith(".env."):
        return "environment file"
    if base == HANDOFF_BASENAME:
        return "private design handoff"
    if parts and parts[0] in SENSITIVE_DIRS:
        return f"under {parts[0]}/"
    if p == LOCAL_SETTINGS or p.endswith("/" + LOCAL_SETTINGS):
        return "machine-local settings"
    for pat in SENSITIVE_BASENAME_GLOBS:
        if fnmatch.fnmatch(base, pat):
            return f"matches `{pat}`"
    return None


def secrets_deny(hits: list[tuple[str, str]], gcwd: str, staged: bool) -> str:
    shown = "\n".join(f"  {p}  ({reason})" for p, reason in hits[:LIMIT])
    more = f"\n  … and {len(hits) - LIMIT} more" if len(hits) > LIMIT else ""
    if staged:
        instruction = ("Unstage them and commit only the rest: "
                        "`git restore --staged <path>` for each path above.")
    else:
        instruction = "Do not add them; stage only the paths you actually intend to commit."
    return (
        f"[vigil preflight] this would stage or commit a path that must never enter git "
        f"history, in {gcwd}:\n{shown}{more}\n"
        f"{instruction} There is no acknowledgement flag for this guard."
    )


def commit_pathspec(args: list[str]) -> tuple[bool, bool]:
    """(has_pathspec, all_flag) for the tokens after `git commit`."""
    has_path = False
    all_flag = False
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--":
            has_path = has_path or i + 1 < len(args)
            break
        if a in ("-a", "--all"):
            all_flag = True
        elif a.startswith("-") and not a.startswith("--") and len(a) > 2 and "=" not in a:
            # combined short flags such as -am / -asm
            if "a" in a[1:]:
                all_flag = True
            if any(ch in "mFCct" for ch in a[1:]) and i + 1 < len(args) and a[-1] in "mFCct":
                i += 1
        elif a in COMMIT_VALUE_OPTS:
            i += 1
        elif a.startswith("-"):
            pass
        else:
            has_path = True
        i += 1
    return has_path, all_flag


def gate_violation(seg: list[str]) -> str | None:
    """A local gate run: pnpm test/lint/typecheck/verify (any sub-script) or a Vitest
    invocation, direct or through a runner."""
    if not seg:
        return None
    if os.path.basename(seg[0]) == "vitest":
        return "vitest"
    if seg[0] in RUNNERS and len(seg) > 1 and seg[1] == "vitest":
        return f"{seg[0]} vitest"
    if seg[0] != "pnpm":
        return None
    i = 1
    while i < len(seg):
        t = seg[i]
        if t in PNPM_PASSTHROUGH or t.startswith("--workspace-concurrency") or t.startswith("--filter="):
            i += 1
        elif t in ("--filter", "-F", "-C", "--dir"):
            i += 2
        else:
            break
    if i >= len(seg):
        return None
    script = seg[i]
    if GATE_SCRIPT.match(script) and script not in GATE_ALLOWED:
        return f"pnpm {script}"
    return None


def check(command: str, start_cwd: str) -> str | None:
    """Return a deny reason for this Bash command, or None to allow it."""
    tokens = tokenize(command)
    for raw in segments(tokens):
        gate = gate_violation(strip_env_prefix(raw))
        if gate:
            return (
                f"[vigil preflight] `{gate}` is a local gate run, and those are off-limits here "
                "(owner ruling: GitHub Actions CI is the required gate for this repository, not "
                "this machine). Push the branch and read CI's result; diagnose from CI logs and "
                "by reading code. Only `pnpm lint:docs` is sanctioned locally, for "
                "documentation-only changes."
            )

    ack_index = any(t == ACK_INDEX for t in tokens)
    cwd = start_cwd
    sweep_add = False

    for raw in segments(tokens):
        seg = strip_env_prefix(raw)
        if not seg:
            continue
        head = seg[0]

        if head in ("cd", "pushd") and len(seg) >= 2:
            cwd = resolve(cwd, seg[1])
            continue

        if head != "git":
            continue

        # git global options
        i = 1
        gcwd = cwd
        while i < len(seg) and seg[i].startswith("-"):
            if seg[i] == "-C" and i + 1 < len(seg):
                gcwd = resolve(cwd, seg[i + 1]); i += 2
            elif seg[i].startswith("-C") and len(seg[i]) > 2:
                gcwd = resolve(cwd, seg[i][2:]); i += 1
            elif seg[i] == "-c" and i + 1 < len(seg):
                i += 2
            else:
                i += 1
        if i >= len(seg):
            continue
        sub, rest = seg[i], seg[i + 1:]

        if sub == "add":
            if any(t in SWEEP_ADD for t in rest):
                sweep_add = True
                if is_repo(gcwd):
                    hits = []
                    for p in status_paths(gcwd):
                        reason = is_sensitive(p)
                        if reason:
                            hits.append((p, reason))
                    if hits:
                        return secrets_deny(hits, gcwd, staged=False)
            else:
                hits = []
                for p in rest:
                    if p.startswith("-"):
                        continue
                    reason = is_sensitive(p)
                    if reason:
                        hits.append((p, reason))
                if hits:
                    return secrets_deny(hits, gcwd, staged=False)
            continue

        if sub != "commit" or not is_repo(gcwd):
            continue

        # The secrets guard applies to the whole staged set, with no override,
        # regardless of whether this commit narrows itself with a pathspec.
        staged_for_secrets = git(gcwd, "diff", "--cached", "--name-only").splitlines()
        hits = []
        for p in staged_for_secrets:
            reason = is_sensitive(p)
            if reason:
                hits.append((p, reason))
        if hits:
            return secrets_deny(hits, gcwd, staged=True)

        has_path, all_flag = commit_pathspec(rest)
        if has_path or ack_index or "--dry-run" in rest:
            continue
        branch = git(gcwd, "branch", "--show-current") or "(detached)"
        if all_flag or sweep_add:
            status = git(gcwd, "status", "--porcelain", "--untracked-files=normal").splitlines()
            if not status:
                continue
            shown = "\n".join("  " + l for l in status[:LIMIT])
            return (
                f"[vigil preflight] this commit sweeps the whole working tree of {gcwd} ({branch}) — "
                f"`-a` / `git add -A` stage everything, including other sessions' work:\n{shown}\n"
                f"Commit by pathspec instead: git add <paths> && git commit -m \"…\" -- <paths>. "
                f"If every entry above is yours, re-run with {ACK_INDEX} in front of the command."
            )
        staged = git(gcwd, "diff", "--cached", "--name-status").splitlines()
        if not staged:
            continue
        shown = "\n".join("  " + l for l in staged[:LIMIT])
        return (
            f"[vigil preflight] `git commit` with no pathspec would commit everything already staged in "
            f"{gcwd} ({branch}):\n{shown}\n"
            "Other sessions stage work in this checkout. Commit by pathspec — git commit -m \"…\" -- <paths> — "
            f"or, if every entry above is yours, re-run with {ACK_INDEX} in front of the command."
        )

    return None


def main() -> int:
    if len(sys.argv) > 1 and sys.argv[1] == "--report":
        target = os.path.abspath(sys.argv[2]) if len(sys.argv) > 2 else os.getcwd()
        clean, text = tree_report(target)
        print(text)
        return 0 if clean else 1

    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0
    if not isinstance(payload, dict):
        return 0
    if payload.get("tool_name") != "Bash":
        return 0
    command = (payload.get("tool_input") or {}).get("command") or ""
    if not any(k in command for k in ("git", "pnpm", "vitest", "npx", "pnpx", "bunx")):
        return 0
    start = payload.get("cwd") or os.getcwd()

    try:
        deny = check(command, start)
    except Exception as exc:  # never break a tool call on our own bug
        print(f"[vigil preflight] skipped: {exc}", file=sys.stderr)
        return 0

    if deny:
        print(deny, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
