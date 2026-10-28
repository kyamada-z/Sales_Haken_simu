#!/usr/bin/env python3
"""Sales-only automatic release boundaries; no write APIs or arbitrary origins."""
import argparse
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import time

spec = importlib.util.spec_from_file_location("pilot", Path(__file__).with_name("security-pilot.py"))
pilot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pilot)
require = pilot.require
TRUSTED = "8a918ea18fc42d5312d840e1c8706b2b07f26a05"
WORKFLOW = ".github/workflows/pages-auto-release.yml"
ACTIVATION_PATHS = {WORKFLOW, ".github/workflows/security-auto-verify.yml", "scripts/security-auto-release.py", "scripts/security-auto-release.test.py"}
ACTIVATION_CHANGES = {("A", p) for p in ACTIVATION_PATHS} | {("M", ".github/workflows/security-verify.yml")}
DEPENDENCIES = {"package.json", "package-lock.json"}
BOOTSTRAP_SOURCE = "2b173dc67dcddcaf7e6f0c354bbb08b123675a28"
BOOTSTRAP = {"index.html": "8de3cc6d270447c04532dc378ad5b0530acdad4d2d583a5c924e1922e0f0c113",
             "assets/index-DMZCvFzF.js": "45bdedc266a05dfabc943c22022bd73f09f2eadebcea4a744547e78f5288b5af"}


def git(repo, *args):
    # Only this process needs the ephemeral read token; child commands never receive it.
    env = {k: v for k, v in os.environ.items() if k not in {"GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN"}}
    return subprocess.check_output(["git", "-C", str(repo), *args], stderr=subprocess.PIPE, env=env)


def sha(value):
    require(isinstance(value, str) and pilot.SHA1.fullmatch(value), "Expected a full commit SHA")
    return value


def changes(repo, before, after):
    data = git(repo, "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-status", "-z", sha(before), sha(after), "--")
    require(not data or data.endswith(b"\0"), "Malformed changed-path list")
    fields = data[:-1].decode().split("\0") if data else []
    require(len(fields) % 2 == 0, "Malformed changed-path fields")
    return list(zip(fields[::2], fields[1::2]))


def assess(repo, before, head, setup=False):
    sha(before); sha(head)
    require(git(repo, "rev-parse", "HEAD").decode().strip() == head, "Checkout does not match proposed head")
    git(repo, "merge-base", "--is-ancestor", TRUSTED, head)
    # Read-only setup CI can test a revised branch tree; main activation is separately single-parent guarded.
    initial = changes(repo, TRUSTED, head)
    if setup and before == TRUSTED and len(initial) == len(ACTIVATION_CHANGES) and set(initial) == ACTIVATION_CHANGES:
        return {"mode": "setup", "eligible": False, "head": head, "base": before, "trusted": TRUSTED}
    history = git(repo, "rev-list", "--first-parent", "--reverse", TRUSTED + ".." + head).decode().splitlines()
    require(bool(history), "Activation ancestor is missing")
    activation = sha(history[0])
    parents = git(repo, "show", "-s", "--format=%P", activation).decode().split()
    require(parents == [TRUSTED], "Activation must be a direct child of the trusted baseline")
    require(set(changes(repo, TRUSTED, activation)) == ACTIVATION_CHANGES, "Activation changed unexpected files")
    cumulative = changes(repo, activation, head)
    require(all(status == "M" and path in DEPENDENCIES for status, path in cumulative), "Application/automation drift since activation is forbidden")
    delta = changes(repo, before, head)
    require(bool(delta) and all(status == "M" and path in DEPENDENCIES for status, path in delta), "Only existing package.json/package-lock.json changes are eligible")
    require(git(repo, "cat-file", "-t", head + ":package-lock.json").decode().strip() == "blob", "A committed lockfile is required")
    git(repo, "merge-base", "--is-ancestor", before, head)
    return {"mode": "release", "eligible": True, "head": head, "base": before, "trusted": TRUSTED, "activation": activation, "paths": [p for _, p in delta]}


def api(path, token):
    return pilot.api_json("https://api.github.com/repos/" + pilot.REPOSITORY + path, token)


def event_guard(event, env, repo):
    require(env.get("GITHUB_EVENT_NAME") == "push" and env.get("GITHUB_REPOSITORY") == pilot.REPOSITORY and env.get("GITHUB_REF") == "refs/heads/main", "Only this repository's main push can publish")
    head = sha(env.get("GITHUB_SHA")); before = sha(event.get("before"))
    require(env.get("GITHUB_WORKFLOW_SHA") == head and env.get("GITHUB_WORKFLOW_REF") == pilot.REPOSITORY + "/" + WORKFLOW + "@refs/heads/main", "Workflow identity mismatch")
    require(event.get("repository", {}).get("full_name") == pilot.REPOSITORY and event.get("ref") == "refs/heads/main" and event.get("after") == head and event.get("head_commit", {}).get("id") == head, "Push identity mismatch")
    require(all(event.get(k) is False for k in ["forced", "created", "deleted"]), "Forced/created/deleted pushes cannot release")
    require(before != "0" * 40, "A prior main commit is required")
    parents = git(repo, "show", "-s", "--format=%P", head).decode().split()
    require(len(parents) in [1, 2] and parents[0] == before, "Push must advance main by exactly one first-parent commit")
    result = assess(repo, before, head, setup=True)
    if result["mode"] == "setup":
        require(before == TRUSTED and parents == [TRUSTED], "Only the first direct-child activation is setup mode on main")
    token = env.get("GH_TOKEN", "")
    require(bool(token), "Ephemeral read token is missing")
    for key in ["GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"]:
        require(re.fullmatch(r"[1-9][0-9]*", env.get(key, "")), "Invalid run identity")
    run = api("/actions/runs/" + env["GITHUB_RUN_ID"], token)
    require(run.get("repository", {}).get("full_name") == pilot.REPOSITORY and run.get("head_branch") == "main" and run.get("event") == "push", "Run repository/branch/event mismatch")
    require(run.get("path") == WORKFLOW and run.get("head_sha") == head and run.get("run_attempt") == int(env["GITHUB_RUN_ATTEMPT"]), "Run workflow/head/attempt mismatch")
    require(api("/git/ref/heads/main", token).get("object", {}).get("sha") == head, "Main moved; refuse publication or rollback")
    return result


def select_previous(repo, head, token):
    runs = api("/actions/workflows/pages-auto-release.yml/runs?branch=main&event=push&status=success&per_page=100", token)
    for run in runs.get("workflow_runs", []):
        require(run.get("repository", {}).get("full_name") == pilot.REPOSITORY and run.get("head_branch") == "main" and run.get("event") == "push" and run.get("path") == WORKFLOW, "Previous run identity mismatch")
        require(run.get("status") == "completed" and run.get("conclusion") == "success", "Previous run is not successful")
        run_id = str(run["id"]); attempt = str(run["run_attempt"]); source = sha(run.get("head_sha"))
        require(re.fullmatch(r"[1-9][0-9]*", run_id) and re.fullmatch(r"[1-9][0-9]*", attempt), "Invalid previous run/attempt")
        jobs = api("/actions/runs/" + run_id + "/jobs?per_page=100", token).get("jobs", [])
        if not any(j.get("name") == "release" and j.get("conclusion") == "success" for j in jobs):
            # The activation build has release=skipped and cannot attest a published site.
            continue
        git(repo, "merge-base", "--is-ancestor", source, head)
        name = "sales-auto-published-candidate-" + run_id + "-" + attempt
        artifacts = api("/actions/runs/" + run_id + "/artifacts?per_page=100", token).get("artifacts", [])
        matches = [a for a in artifacts if a.get("name") == name]
        require(len(matches) == 1 and matches[0].get("expired") is False, "Known-good candidate artifact missing/expired; an exception needs review")
        require(0 < matches[0].get("size_in_bytes", 0) <= pilot.MAX_BUNDLE, "Previous artifact size is invalid")
        return {"kind": "artifact", "source_commit": source, "run_id": run_id, "run_attempt": attempt, "artifact_name": name}
    require(not runs.get("total_count", 0) > 100, "Previous release history exceeds discovery limit; refuse bootstrap guessing")
    return {"kind": "bootstrap", "source_commit": BOOTSTRAP_SOURCE, "files": BOOTSTRAP, "run_id": "", "artifact_name": ""}


def pack(site, kind, source, out):
    sha(source); require(kind in ["candidate", "rollback"], "Unknown bundle kind")
    files = pilot.site_files(site)
    manifest = {"schema": "sales-pages-auto/v1", "repository": pilot.REPOSITORY, "kind": kind, "source_commit": source,
                "origin": pilot.ORIGIN, "base": pilot.BASE, "files": {p: {"bytes": len(b), "sha256": pilot.digest(b)} for p, b in sorted(files.items())}}
    entries = {"site/" + p: b for p, b in files.items()}
    entries["manifest.json"] = (json.dumps(manifest, sort_keys=True, indent=2) + "\n").encode()
    data = pilot.canonical_tar(entries)
    require(not out.exists(), "Immutable bundle output exists")
    out.parent.mkdir(parents=True, exist_ok=True); out.write_bytes(data)
    return {"kind": kind, "source_commit": source, "bundle_sha256": pilot.digest(data), "files": manifest["files"]}


def verify(bundle, summary):
    require(set(summary) == {"kind", "source_commit", "bundle_sha256", "files"}, "Unexpected summary fields")
    sha(summary["source_commit"])
    require(summary["kind"] in ["candidate", "rollback"] and pilot.SHA256.fullmatch(summary["bundle_sha256"]), "Invalid summary identity")
    require(bundle.is_file() and not bundle.is_symlink() and bundle.stat().st_size <= pilot.MAX_BUNDLE, "Invalid bundle file")
    data = bundle.read_bytes(); require(pilot.digest(data) == summary["bundle_sha256"], "Bundle SHA-256 mismatch")
    entries = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:") as archive:
        for member in archive:
            require(member.isfile() and not member.issym() and not member.islnk(), "Non-regular archive entry")
            name = member.name
            allowed = name in ["manifest.json", "site/index.html"] or name.startswith("site/") and pilot.JS_PATH.fullmatch(name[5:])
            require(allowed and name not in entries and 0 <= member.size <= pilot.MAX_FILE, "Unexpected/duplicate/oversized archive entry")
            entries[name] = archive.extractfile(member).read()
    require(len(entries) == 3 and "manifest.json" in entries, "Expected exactly three archive entries")
    manifest = json.loads(entries.pop("manifest.json"), object_pairs_hook=pilot.unique_object)
    require(set(manifest) == {"schema", "repository", "kind", "source_commit", "origin", "base", "files"}, "Unexpected manifest fields")
    require(manifest["schema"] == "sales-pages-auto/v1" and manifest["repository"] == pilot.REPOSITORY and manifest["origin"] == pilot.ORIGIN and manifest["base"] == pilot.BASE, "Manifest origin/schema/repository mismatch")
    require(manifest["kind"] == summary["kind"] and manifest["source_commit"] == summary["source_commit"], "Manifest source/kind mismatch")
    files = {p[5:]: b for p, b in entries.items()}; pilot.check_site(files)
    actual = {p: {"bytes": len(b), "sha256": pilot.digest(b)} for p, b in sorted(files.items())}
    require(manifest["files"] == actual == summary["files"], "File hash/size mismatch")
    return manifest, files


def materialize(files, out):
    require(not out.exists(), "Output site already exists")
    for path, value in files.items():
        target = out / path; target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(value)


def capture(selection, previous, previous_summary, out, bundle):
    if selection["kind"] == "bootstrap":
        require(selection["source_commit"] == BOOTSTRAP_SOURCE and selection["files"] == BOOTSTRAP, "Bootstrap identity mismatch")
        expected = BOOTSTRAP
    else:
        require(selection["kind"] == "artifact" and previous is not None and previous_summary is not None, "Previous immutable candidate is required")
        manifest, _ = verify(previous, previous_summary)
        require(manifest["kind"] == "candidate" and manifest["source_commit"] == selection["source_commit"], "Previous artifact source/kind mismatch")
        expected = {p: f["sha256"] for p, f in manifest["files"].items()}
    files = {p: pilot.public_bytes(p) for p in expected}
    require({p: pilot.digest(b) for p, b in files.items()} == expected, "Live bytes are not the recorded known-good release; refuse capture")
    pilot.check_site(files); materialize(files, out)
    return pack(out, "rollback", selection["source_commit"], bundle)


def known_live(bundles, allowed):
    choices = {}
    for kind, (bundle, summary) in bundles.items():
        manifest, files = verify(bundle, summary); require(manifest["kind"] == kind, "Selected bundle kind mismatch")
        choices[kind] = files
    index = pilot.public_bytes("index.html")
    for kind in allowed:
        files = choices[kind]
        if pilot.digest(index) == pilot.digest(files["index.html"]):
            for path, value in files.items():
                if path != "index.html":
                    require(pilot.digest(pilot.public_bytes(path)) == pilot.digest(value), "Known index has unexpected JavaScript; refuse overwrite")
            return {"known_live": kind, "files": {p: pilot.digest(b) for p, b in files.items()}}
    raise ValueError("Unknown live version; refuse overwrite")


def read_json(path):
    return json.loads(pilot.read_limited(path), object_pairs_hook=pilot.unique_object)


def main():
    p = argparse.ArgumentParser(description=__doc__); sub = p.add_subparsers(dest="command", required=True)
    q = sub.add_parser("assess"); q.add_argument("--repo", type=Path, required=True); q.add_argument("--base", required=True); q.add_argument("--head", required=True); q.add_argument("--allow-setup", action="store_true")
    q = sub.add_parser("guard"); q.add_argument("--repo", type=Path, required=True); q.add_argument("--event", type=Path, required=True)
    q = sub.add_parser("select-previous"); q.add_argument("--repo", type=Path, required=True); q.add_argument("--head", required=True)
    q = sub.add_parser("pack"); q.add_argument("--site", type=Path, required=True); q.add_argument("--kind", choices=["candidate", "rollback"], required=True); q.add_argument("--source", required=True); q.add_argument("--out", type=Path, required=True)
    q = sub.add_parser("capture"); q.add_argument("--selection", type=Path, required=True); q.add_argument("--previous", type=Path); q.add_argument("--previous-summary", type=Path); q.add_argument("--out", type=Path, required=True); q.add_argument("--bundle", type=Path, required=True)
    q = sub.add_parser("extract"); q.add_argument("--bundle", type=Path, required=True); q.add_argument("--summary", type=Path, required=True); q.add_argument("--out", type=Path, required=True); q.add_argument("--kind", choices=["candidate", "rollback"], required=True); q.add_argument("--source", required=True); q.add_argument("--sha256", required=True)
    q = sub.add_parser("known-live"); q.add_argument("--candidate", type=Path, required=True); q.add_argument("--candidate-summary", type=Path, required=True); q.add_argument("--rollback", type=Path, required=True); q.add_argument("--rollback-summary", type=Path, required=True); q.add_argument("--allow", choices=["candidate", "rollback", "either"], required=True); q.add_argument("--attempts", type=int, choices=range(1, 7), default=1)
    args = p.parse_args()
    if args.command == "assess": result = assess(args.repo, args.base, args.head, args.allow_setup)
    elif args.command == "guard": result = event_guard(read_json(args.event), os.environ, args.repo)
    elif args.command == "select-previous": result = select_previous(args.repo, sha(args.head), os.environ.get("GH_TOKEN", ""))
    elif args.command == "pack": result = pack(args.site, args.kind, args.source, args.out)
    elif args.command == "capture": result = capture(read_json(args.selection), args.previous, read_json(args.previous_summary) if args.previous_summary else None, args.out, args.bundle)
    elif args.command == "extract":
        summary = read_json(args.summary)
        require(summary["kind"] == args.kind and summary["source_commit"] == sha(args.source) and summary["bundle_sha256"] == args.sha256, "Prepared bundle output identity mismatch")
        manifest, files = verify(args.bundle, summary); materialize(files, args.out); result = manifest
    else:
        bundles = {"candidate": (args.candidate, read_json(args.candidate_summary)), "rollback": (args.rollback, read_json(args.rollback_summary))}
        for attempt in range(args.attempts):
            try:
                result = known_live(bundles, ["candidate", "rollback"] if args.allow == "either" else [args.allow]); break
            except (ValueError, OSError) as error:
                if attempt == args.attempts - 1: raise
                print("Waiting for exact published bytes: " + str(error), file=sys.stderr); time.sleep(10)
    print(json.dumps(result, sort_keys=True, indent=2))


if __name__ == "__main__":
    try: main()
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError, tarfile.TarError) as error:
        print("Automatic release rejected: " + str(error), file=sys.stderr); sys.exit(1)
