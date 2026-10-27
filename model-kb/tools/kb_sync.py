#!/usr/bin/env python3
"""Keep a shared model-kb current when several people (and their agents) work in one Git repository.

Each clone records which commit its owner has already folded into the KB. Commits pushed by
teammates after that point are "not ingested": read them with `digest`, update model-kb/, then `mark`.

  status   fetch and report teammate commits not yet folded into the KB (exit 1 with --check if any)
  pull     fast-forward to upstream, then print the digest of teammate commits to ingest
  digest   print teammate commits since the marker: message, files, and the model-kb/ diff
  mark     record a commit (default HEAD) as folded into the KB
  log      create one conflict-free entry file under model-kb/log/
  install-hook   add a local post-merge hook that runs `status --no-fetch` after every pull

The marker lives inside .git (per clone, never committed). Standard library only.
"""

import argparse
import datetime as dt
import re
import subprocess
import sys
from pathlib import Path

KB = "model-kb"
MARKER = "model-kb-sync"


class SyncError(Exception):
    pass


def git(*args, check=True):
    result = subprocess.run(["git", *args], capture_output=True, text=True)
    if check and result.returncode != 0:
        raise SyncError(f"git {' '.join(args)} failed: {result.stderr.strip() or result.stdout.strip()}")
    return result.stdout.strip()


def root():
    return Path(git("rev-parse", "--show-toplevel"))


def git_path(name):
    """A path inside this clone's .git (per worktree), resolved from the current directory."""
    path = Path(git("rev-parse", "--git-path", name))
    return path if path.is_absolute() else Path.cwd() / path


def marker_path():
    return git_path(MARKER)


def read_marker():
    path = marker_path()
    words = path.read_text(encoding="utf-8").split() if path.is_file() else []
    if words and git("cat-file", "-t", words[0], check=False) == "commit":
        return words[0]
    return None


def write_marker(sha):
    path = marker_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    path.write_text(f"{sha} {stamp}\n", encoding="utf-8")


def upstream():
    return git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}", check=False) or None


def me():
    return git("config", "user.email", check=False).lower()


def commits(since, tips, include_mine=False):
    """Commits reachable from any of tips but not from since (oldest first), excluding merges and, by default,
    the caller's own."""
    tips = [tips] if isinstance(tips, str) else list(tips)
    spec = ([f"^{since}"] if since else []) + tips
    out = git("log", "--reverse", "--no-merges", "--format=%H%x1f%ae%x1f%an%x1f%ad%x1f%s", "--date=short", *spec)
    rows = []
    for line in out.splitlines():
        sha, email, name, date, subject = line.split("\x1f")
        if include_mine or email.lower() != me():
            rows.append({"sha": sha, "email": email, "name": name, "date": date, "subject": subject})
    return rows


def files_of(sha):
    out = git("show", "--no-renames", "--format=", "--name-status", sha)
    return [tuple(line.split("\t", 1)) for line in out.splitlines() if "\t" in line]


def baseline():
    """Where ingestion starts: the marker, or the merge-base with upstream on first use."""
    marker = read_marker()
    if marker:
        return marker, "marker"
    up = upstream()
    if up:
        return git("merge-base", "HEAD", up, check=False) or None, "first run: merge-base with upstream"
    return None, "first run: no upstream"


def cmd_status(args):
    up = upstream()
    if up and not args.no_fetch:
        git("fetch", "--quiet")
    base, why = baseline()
    print(f"KB sync marker: {base[:10] if base else 'none'} ({why})")
    if not up:
        print("No upstream branch: nothing to sync from. Set one with `git branch -u <remote>/<branch>`.")
        return 0
    if not base:
        print("No common history with upstream yet; read model-kb/README.md, then run `kb_sync.py mark`.")
        return 0
    behind = int(git("rev-list", "--count", f"HEAD..{up}"))
    ahead = int(git("rev-list", "--count", f"{up}..HEAD"))
    print(f"Upstream {up}: {behind} commit(s) to pull, {ahead} local commit(s) not pushed")
    pending = commits(base, ["HEAD", up]) if base else []
    if not pending:
        print("Teammate commits not yet in the KB: none")
        return 0
    print(f"Teammate commits not yet in the KB: {len(pending)}")
    for c in pending:
        touched = files_of(c["sha"])
        kb = sum(1 for _, f in touched if f.startswith(KB + "/"))
        note = f"{kb} KB file(s)" if kb else "code only — no KB update"
        print(f"  {c['sha'][:10]} {c['date']} {c['name']}: {c['subject']}  [{note}]")
    print("Next: `kb_sync.py pull` (or `digest` if already pulled), fold the changes into model-kb/, then `kb_sync.py mark`.")
    return 1 if args.check else 0


def cmd_digest(args):
    base = args.since or baseline()[0]
    head = args.until or "HEAD"
    rows = commits(base, head, include_mine=args.all)
    print(f"# Teammate changes to fold into the KB ({base[:10] if base else 'start'}..{git('rev-parse', '--short', head)})\n")
    if not rows:
        print("None.")
        return 0
    for c in rows:
        print(f"## {c['sha'][:10]} · {c['date']} · {c['name']} <{c['email']}>")
        print(f"**{c['subject']}**\n")
        body = git("show", "-s", "--format=%b", c["sha"])
        if body:
            print(body[: args.max_body] + ("\n…" if len(body) > args.max_body else "") + "\n")
        touched = files_of(c["sha"])
        code = [f"{s} {f}" for s, f in touched if not f.startswith(KB + "/")]
        kbf = [f"{s} {f}" for s, f in touched if f.startswith(KB + "/")]
        if code:
            print("Code/other files: " + ", ".join(code[:40]) + (" …" if len(code) > 40 else "") + "\n")
        if kbf:
            diff = git("show", "--format=", c["sha"], "--", KB)
            lines = diff.splitlines()
            print("KB diff:\n```diff")
            print("\n".join(lines[: args.max_diff]))
            if len(lines) > args.max_diff:
                print(f"… ({len(lines) - args.max_diff} more lines: git show {c['sha'][:10]} -- {KB})")
            print("```\n")
        else:
            print("KB diff: none — derive any lasting fact from the code change and label it with this commit.\n")
    print("When these are reflected in model-kb/, run `kb_sync.py mark`.")
    return 0


def cmd_pull(args):
    up = upstream()
    if not up:
        raise SyncError("No upstream branch to pull from.")
    before = git("rev-parse", "HEAD")
    git("fetch", "--quiet")
    if subprocess.run(["git", "merge-base", "--is-ancestor", "HEAD", up]).returncode != 0:
        raise SyncError(f"HEAD and {up} have diverged. Merge or rebase is a user decision: "
                        f"run `git pull --rebase` or `git merge {up}` yourself, then `kb_sync.py digest`.")
    result = subprocess.run(["git", "merge", "--ff-only", "--quiet", up], capture_output=True, text=True)
    if result.returncode != 0:
        raise SyncError(f"Fast-forward failed (local changes in the way?): {result.stderr.strip()}")
    print(f"Fast-forwarded {before[:10]} → {git('rev-parse', '--short', 'HEAD')}\n")
    return cmd_digest(argparse.Namespace(since=None, until=None, all=False, max_body=args.max_body, max_diff=args.max_diff))


def cmd_mark(args):
    sha = git("rev-parse", args.ref)
    if subprocess.run(["git", "merge-base", "--is-ancestor", sha, "HEAD"]).returncode != 0:
        raise SyncError(f"{args.ref} is not in the current branch; pull it before marking it ingested.")
    write_marker(sha)
    print(f"KB marked current up to {sha[:10]}")
    return 0


def cmd_log(args):
    who = re.sub(r"[^a-z0-9]+", "-", (me().split("@")[0] or "someone").lower()).strip("-")
    slug = re.sub(r"[^a-z0-9]+", "-", args.summary.lower()).strip("-")[:48] or "entry"
    now = dt.datetime.now().astimezone()
    folder = root() / KB / "log"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{now:%Y-%m-%d-%H%M}-{who}-{slug}.md"
    if path.exists():
        raise SyncError(f"Entry already exists: {path}")
    topics = ", ".join(args.topic) if args.topic else "—"
    path.write_text(
        f"# {args.summary}\n\n- Date: {now:%Y-%m-%d %H:%M %z}\n- Author: {me() or 'unknown'}\n- Topics updated: {topics}\n"
        f"- Status: observed | decided | planned | open question\n\n## What changed and why\n\n\n## Evidence\n\n",
        encoding="utf-8")
    print(path.relative_to(root()))
    return 0


def cmd_install_hook(args):
    hooks = git_path("hooks")
    hook = hooks / "post-merge"
    line = "python3 model-kb/tools/kb_sync.py status --no-fetch || true"
    if hook.exists():
        content = hook.read_text(encoding="utf-8")
        if line in content:
            print(f"Hook already installed: {hook}")
            return 0
        hook.write_text(content.rstrip("\n") + f"\n{line}\n", encoding="utf-8")
    else:
        hooks.mkdir(parents=True, exist_ok=True)
        hook.write_text(f"#!/bin/sh\n# model-kb: show teammate commits not yet folded into the KB\n{line}\n", encoding="utf-8")
    hook.chmod(0o755)
    print(f"Installed {hook}")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("status"); p.add_argument("--no-fetch", action="store_true"); p.add_argument("--check", action="store_true")
    p.set_defaults(func=cmd_status)
    for name, func in (("digest", cmd_digest), ("pull", cmd_pull)):
        p = sub.add_parser(name)
        if name == "digest":
            p.add_argument("--since"); p.add_argument("--until"); p.add_argument("--all", action="store_true", help="include your own commits")
        p.add_argument("--max-body", type=int, default=1500); p.add_argument("--max-diff", type=int, default=200)
        p.set_defaults(func=func)
    p = sub.add_parser("mark"); p.add_argument("ref", nargs="?", default="HEAD"); p.set_defaults(func=cmd_mark)
    p = sub.add_parser("log"); p.add_argument("summary"); p.add_argument("--topic", action="append"); p.set_defaults(func=cmd_log)
    p = sub.add_parser("install-hook"); p.set_defaults(func=cmd_install_hook)
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except SyncError as error:
        print(f"kb_sync: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
