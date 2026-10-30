#!/usr/bin/env python3
"""One user-authorized release of the compact simulation header, 2026-10-30."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import urllib.request

REPOSITORY = "kyamada-z/Sales_Haken_simu"
OLD_MAIN = "7fa49c74c8686ac884f29d885183740cf6b0fd5f"
OLD_SOURCE = "1ed7dff5bdc9c5e4018c26584b07fa15b40accf2"
FEATURE = "785892583ab41367bd3184337ca58fee03452ddf"
TRUSTED = "3c5b3a06e238eac6095f16cfa5ee71012f4ca535"
WORKFLOW = ".github/workflows/header-release-once.yml"
TEMPLATE = "security/header-release-once.yml.in"
OLD_RUN = 41014980467
OLD_ARTIFACT = 12959097819
OLD_ARTIFACT_NAME = "sales-profit-published-candidate-41014980467-1"
RELEASE_ADDITIONS = {
    WORKFLOW, TEMPLATE, ".github/workflows/header-preflight.yml",
    "scripts/header-release.py", "scripts/header-release.test.py",
    "scripts/header-release-browser.mjs",
}
ROOT = Path(__file__).resolve().parent.parent


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(value):
    require(isinstance(value, str) and re.fullmatch(r"[0-9a-f]{40}", value), "Full SHA required")
    return value


def git(repo, *args):
    env = {k: v for k, v in os.environ.items() if k not in {"GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN"}}
    return subprocess.check_output(["git", "-C", str(repo), *args], env=env, stderr=subprocess.PIPE)


def blob(data):
    return hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()


def tree(repo, revision):
    result = {}
    for record in git(repo, "ls-tree", "-rz", "--full-tree", sha(revision)).split(b"\0"):
        if not record:
            continue
        metadata, name = record.split(b"\t", 1)
        mode, kind, oid = metadata.decode().split()
        name = name.decode()
        require(mode in {"100644", "100755"} and kind == "blob", "Nonregular tracked entry")
        require(re.fullmatch(r"[A-Za-z0-9._/-]+", name) and ".." not in name.split("/"), "Unsafe path")
        result[name] = (mode, kind, oid)
    return result


def raw_integrity(repo, revision, generated=False):
    require(git(repo, "rev-parse", "HEAD").decode().strip() == revision, "Checkout identity changed")
    for name, (mode, kind, oid) in tree(repo, revision).items():
        path = repo / name
        info = path.lstat()
        require(stat.S_ISREG(info.st_mode) and not path.is_symlink(), "Nonregular file: " + name)
        require(bool(info.st_mode & 0o111) == (mode == "100755"), "Mode changed: " + name)
        require(blob(path.read_bytes()) == oid, "Bytes changed: " + name)
    for value in git(repo, "ls-files", "--others", "-z").split(b"\0"):
        if value:
            name = value.decode()
            require(generated and name.startswith(("node_modules/", "dist/")), "Unexpected generated file: " + name)


def api(path):
    token = os.environ.get("GH_TOKEN", "")
    require(bool(token), "Ephemeral read token required")
    request = urllib.request.Request("https://api.github.com/repos/" + REPOSITORY + path,
        headers={"Accept": "application/vnd.github+json", "Authorization": "Bearer " + token,
                 "X-GitHub-Api-Version": "2022-11-28"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def guard(repo, trusted, candidate):
    env = os.environ
    head = sha(env.get("GITHUB_SHA"))
    tools_sha = sha(env.get("RELEASE_TOOLS_SHA"))
    require(env.get("GITHUB_EVENT_NAME") == "push" and env.get("GITHUB_REPOSITORY") == REPOSITORY and env.get("GITHUB_REF") == "refs/heads/main", "Only authorized main push")
    require(env.get("GITHUB_WORKFLOW_SHA") == head and env.get("GITHUB_WORKFLOW_REF") == REPOSITORY + "/" + WORKFLOW + "@refs/heads/main", "Workflow identity mismatch")
    event = json.loads(Path(env["GITHUB_EVENT_PATH"]).read_text())
    require(event.get("before") == OLD_MAIN and event.get("after") == head and event.get("head_commit", {}).get("id") == head, "Not the one authorized main transition")
    require(event.get("ref") == "refs/heads/main" and event.get("repository", {}).get("full_name") == REPOSITORY, "Event repository mismatch")
    require(all(event.get(key) is False for key in ["forced", "created", "deleted"]), "Forced/deleted/new ref forbidden")
    parents = git(repo, "show", "-s", "--format=%P", head).decode().split()
    require(len(parents) in [1, 2] and parents[0] == OLD_MAIN, "Unexpected main parent")
    git(repo, "merge-base", "--is-ancestor", FEATURE, head)
    git(repo, "merge-base", "--is-ancestor", tools_sha, head)
    raw_integrity(ROOT, tools_sha)
    raw_integrity(trusted, TRUSTED)
    raw_integrity(repo, head)
    expected = tree(ROOT, tools_sha)
    require(WORKFLOW not in expected, "Tools baseline must not contain active release workflow")
    template = (ROOT / TEMPLATE).read_bytes()
    require(b"@RELEASE_TOOLS_SHA@" in template, "Missing immutable tools placeholder")
    expected[WORKFLOW] = ("100644", "blob", blob(template.replace(b"@RELEASE_TOOLS_SHA@", tools_sha.encode())))
    require(tree(repo, head) == expected, "Main differs from exact reviewed release tree")
    feature_tree = tree(repo, FEATURE)
    require(set(expected) == set(feature_tree) | RELEASE_ADDITIONS, "Unexpected release addition or deletion")
    for name, entry in feature_tree.items():
        require(expected.get(name) == entry, "Feature or existing protection changed: " + name)
    if candidate:
        raw_integrity(candidate, FEATURE, generated=True)
    run_id = env.get("GITHUB_RUN_ID", "")
    attempt = env.get("GITHUB_RUN_ATTEMPT", "")
    require(re.fullmatch(r"[1-9][0-9]*", run_id) and re.fullmatch(r"[1-9][0-9]*", attempt), "Invalid run identity")
    run = api("/actions/runs/" + run_id)
    require(run.get("head_sha") == head and run.get("head_branch") == "main" and run.get("event") == "push" and run.get("path") == WORKFLOW and run.get("run_attempt") == int(attempt), "Run identity mismatch")
    require(run.get("repository", {}).get("full_name") == REPOSITORY, "Run repository mismatch")
    require(api("/git/ref/heads/main").get("object", {}).get("sha") == head, "Main moved; publication/recovery refused")
    return {"authorized": True, "main": head, "feature": FEATURE, "tools": tools_sha}


def previous(trusted):
    raw_integrity(trusted, TRUSTED)
    run = api("/actions/runs/" + str(OLD_RUN))
    require(run.get("status") == "completed" and run.get("conclusion") == "success", "Old release not successful")
    require(run.get("head_sha") == OLD_MAIN and run.get("head_branch") == "main" and run.get("event") == "push" and run.get("run_attempt") == 1, "Old run identity mismatch")
    require(run.get("repository", {}).get("full_name") == REPOSITORY and run.get("path") == ".github/workflows/profit-release-once.yml", "Old workflow mismatch")
    jobs = api("/actions/runs/" + str(OLD_RUN) + "/jobs?per_page=100").get("jobs", [])
    require(any(j.get("name") == "publish" and j.get("conclusion") == "success" for j in jobs), "Old publication job not successful")
    artifact = api("/actions/artifacts/" + str(OLD_ARTIFACT))
    require(artifact.get("id") == OLD_ARTIFACT and artifact.get("name") == OLD_ARTIFACT_NAME and artifact.get("expired") is False and 0 < artifact.get("size_in_bytes", 0) < 20_000_000, "Old artifact identity/expiry mismatch")
    provenance = artifact.get("workflow_run", {})
    require(provenance.get("id") == OLD_RUN and provenance.get("head_sha") == OLD_MAIN and provenance.get("head_branch") == "main" and provenance.get("repository_id") == 1241342773, "Artifact provenance mismatch")
    return {"kind": "artifact", "source_commit": OLD_SOURCE, "run_id": str(OLD_RUN), "run_attempt": "1", "artifact_name": OLD_ARTIFACT_NAME}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["guard", "previous"])
    parser.add_argument("--repo", type=Path)
    parser.add_argument("--trusted", type=Path, required=True)
    parser.add_argument("--candidate", type=Path)
    args = parser.parse_args()
    result = guard(args.repo, args.trusted, args.candidate) if args.command == "guard" else previous(args.trusted)
    print(json.dumps(result, sort_keys=True, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError) as error:
        print("Authorized feature release rejected: " + str(error), file=sys.stderr)
        sys.exit(1)
