#!/usr/bin/env python3
"""Narrow push-event guard and known-version checks for one authorized Pages drill."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import sys
import time

spec = importlib.util.spec_from_file_location("pilot", Path(__file__).with_name("security-pilot.py"))
pilot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pilot)

BEFORE = "6b943783e4a04cb28c72ce6855eb350557e6517d"
WORKFLOW = ".github/workflows/pages-pilot-once.yml"
CHANGES = {
    WORKFLOW: "added",
    ".github/workflows/security-verify.yml": "modified",
    "scripts/security-pilot-once.py": "added",
    "scripts/security-pilot-once.test.py": "added",
    "scripts/security-pilot-browser.mjs": "added",
}
VERSION = "1.56.1"
INTEGRITY = "sha512-hutraynyn31F+Bifme+Ps9Vq59hKuUCz7H1kDOcBs+2oGguKkWTU50bBWrtz34OUWmIwpBTWDxaRPXrIXkgvmQ=="


def event_identity(event, env):
    require = pilot.require
    require(env.get("GITHUB_EVENT_NAME") == "push", "Only a push event is authorized")
    require(env.get("GITHUB_REPOSITORY") == pilot.REPOSITORY, "Wrong repository")
    require(env.get("GITHUB_REF") == "refs/heads/main", "Only main is authorized")
    sha = env.get("GITHUB_SHA", "")
    require(pilot.SHA1.fullmatch(sha) and sha != BEFORE, "Invalid workflow commit")
    require(env.get("GITHUB_WORKFLOW_SHA") == sha, "Workflow source differs from push head")
    require(env.get("GITHUB_WORKFLOW_REF") == pilot.REPOSITORY + "/" + WORKFLOW + "@refs/heads/main", "Unexpected workflow identity")
    require(event.get("repository", {}).get("full_name") == pilot.REPOSITORY, "Event repository mismatch")
    require(event.get("ref") == "refs/heads/main" and event.get("before") == BEFORE and event.get("after") == sha, "Unapproved predecessor/ref/head")
    require(all(event.get(k) is False for k in ["created", "deleted", "forced"]), "Created/deleted/forced pushes are forbidden")
    require(event.get("head_commit", {}).get("id") == sha, "Event head commit mismatch")
    for key in ["GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"]:
        require(__import__("re").fullmatch(r"[1-9][0-9]*", env.get(key, "")), "Invalid run identity")
    return sha


def guard(event, env):
    sha = event_identity(event, env)
    token = env.get("GH_TOKEN", "")
    pilot.require(bool(token), "Ephemeral GitHub token is missing")
    api = "https://api.github.com/repos/" + pilot.REPOSITORY
    run = pilot.api_json(api + "/actions/runs/" + env["GITHUB_RUN_ID"], token)
    pilot.require(run.get("repository", {}).get("full_name") == pilot.REPOSITORY and run.get("event") == "push" and run.get("head_branch") == "main", "Run repository/event/branch mismatch")
    pilot.require(run.get("path") == WORKFLOW and run.get("head_sha") == sha and run.get("run_attempt") == int(env["GITHUB_RUN_ATTEMPT"]), "Run workflow/head/attempt mismatch")
    commit = pilot.api_json(api + "/commits/" + sha, token)
    pilot.require(commit.get("sha") == sha and [p.get("sha") for p in commit.get("parents", [])] == [BEFORE], "Push must contain exactly one direct child of the approved main")
    files = commit.get("files", [])
    pilot.require(len(files) == len(CHANGES) and {f.get("filename"): f.get("status") for f in files} == CHANGES, "Commit changed unapproved paths/statuses")
    pilot.require(all(not f.get("previous_filename") for f in files), "Renames are forbidden")
    main = pilot.api_json(api + "/git/ref/heads/main", token)
    pilot.require(main.get("object", {}).get("sha") == sha, "Main moved; refuse production mutation")
    return {"verified": True, "workflow_commit": sha, "approved_predecessor": BEFORE,
            "app_commit": pilot.CANDIDATE_COMMIT, "run_id": env["GITHUB_RUN_ID"], "run_attempt": env["GITHUB_RUN_ATTEMPT"]}


def known_live(candidate, candidate_hash, rollback, rollback_hash, allowed):
    choices = {}
    for kind, path, expected, source in [
        ("candidate", candidate, candidate_hash, pilot.CANDIDATE_COMMIT),
        ("rollback", rollback, rollback_hash, pilot.BASELINE_COMMIT),
    ]:
        _, files = pilot.verify(path, expected, kind, source)
        choices[kind] = files
    current = pilot.public_bytes("index.html")
    for kind in allowed:
        files = choices[kind]
        if pilot.digest(current) == pilot.digest(files["index.html"]):
            for path, value in files.items():
                if path != "index.html":
                    pilot.require(pilot.digest(pilot.public_bytes(path)) == pilot.digest(value), "Known index has unexpected JS bytes; refuse overwrite")
            return {"known_live": kind, "files": {p: pilot.digest(b) for p, b in files.items()}}
    raise ValueError("Live index is not an allowed exact version; refuse overwrite")


def tooling(out):
    pilot.require(not out.exists(), "Temporary tooling directory already exists")
    out.mkdir(parents=True)
    package = {"name": "sales-pilot-browser-temporary", "version": "1.0.0", "private": True,
               "dependencies": {"playwright-core": VERSION}}
    lock = {"name": package["name"], "version": "1.0.0", "lockfileVersion": 3, "requires": True,
            "packages": {"": package, "node_modules/playwright-core": {
                "version": VERSION, "resolved": "https://registry.npmjs.org/playwright-core/-/playwright-core-" + VERSION + ".tgz",
                "integrity": INTEGRITY, "license": "Apache-2.0", "bin": {"playwright-core": "cli.js"}, "engines": {"node": ">=18"}}}}
    for name, value in [("package.json", package), ("package-lock.json", lock)]:
        (out / name).write_text(json.dumps(value, indent=2) + "\n")
    return {"tool": "official playwright-core", "version": VERSION, "integrity": INTEGRITY, "temporary": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("guard")
    p.add_argument("--event", type=Path, required=True)
    p = sub.add_parser("tooling")
    p.add_argument("--out", type=Path, required=True)
    p = sub.add_parser("known-live")
    p.add_argument("--candidate", type=Path, required=True)
    p.add_argument("--candidate-sha256", required=True)
    p.add_argument("--rollback", type=Path, required=True)
    p.add_argument("--rollback-sha256", required=True)
    p.add_argument("--allow", choices=["candidate", "rollback", "either"], required=True)
    p.add_argument("--attempts", type=int, choices=range(1, 7), default=1)
    args = parser.parse_args()
    if args.command == "guard":
        result = guard(json.loads(pilot.read_limited(args.event)), os.environ)
    elif args.command == "tooling":
        result = tooling(args.out)
    else:
        allowed = ["candidate", "rollback"] if args.allow == "either" else [args.allow]
        for attempt in range(args.attempts):
            try:
                result = known_live(args.candidate, args.candidate_sha256, args.rollback, args.rollback_sha256, allowed)
                break
            except (ValueError, OSError) as error:
                if attempt == args.attempts - 1:
                    raise
                print("Waiting for exact published bytes: " + str(error), file=sys.stderr)
                time.sleep(10)
    print(json.dumps(result, sort_keys=True, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError) as error:
        print("One-time pilot rejected: " + str(error), file=sys.stderr)
        sys.exit(1)
