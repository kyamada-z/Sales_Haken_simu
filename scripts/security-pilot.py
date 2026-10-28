#!/usr/bin/env python3
"""One-time Sales Pages pilot: exact-byte bundles, strict extraction and live checks.

Standard library only. No app execution, API keys, AI calls, or arbitrary origins.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import sys
import tarfile
import urllib.error
import urllib.request

REPOSITORY = "kyamada-z/Sales_Haken_simu"
ORIGIN = "https://kyamada-z.github.io"
BASE = "/Sales_Haken_simu/"
BASELINE_COMMIT = "e5b859e220c1b21c8611c4c69f603f5ea651f00f"
CANDIDATE_COMMIT = "2b173dc67dcddcaf7e6f0c354bbb08b123675a28"
BASELINE_FILES = {
    "index.html": "107cf98f23d1b0b31ff1e719d96c4ad6c46bc866d5c5b5fb46657d5eb7da028b",
    "assets/index-BYxEu2lC.js": "7209ab4e87305412c30e717767ce904aabcfb67479ca1dff049bb529883c1d8b",
}
EXCLUSIONS = ["external Tailwind CDN bytes", "favicon /vite.svg", "browser localStorage"]
MAX_FILE = 2_000_000
MAX_BUNDLE = 4_100_000
SHA256 = re.compile(r"[0-9a-f]{64}\Z")
SHA1 = re.compile(r"[0-9a-f]{40}\Z")
JS_PATH = re.compile(r"assets/index-[A-Za-z0-9_-]+\.js\Z")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_limited(path):
    require(path.is_file() and not path.is_symlink(), "Expected a regular file")
    require(path.stat().st_size <= MAX_FILE, "File exceeds limit")
    return path.read_bytes()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("HTTP redirects are not allowed")


def public_bytes(path):
    require(path == "index.html" or JS_PATH.fullmatch(path), "Unexpected public path")
    url = ORIGIN + BASE + ("" if path == "index.html" else path)
    req = urllib.request.Request(url, headers={"Cache-Control": "no-cache", "User-Agent": "Sales-security-pilot/1"})
    with urllib.request.build_opener(NoRedirect).open(req, timeout=20) as response:
        require(response.status == 200 and response.url == url, "Unexpected HTTP response")
        data = response.read(MAX_FILE + 1)
    require(len(data) <= MAX_FILE, "HTTP file exceeds limit")
    return data


def check_site(files):
    require(len(files) == 2 and "index.html" in files, "Site must contain index.html and exactly one JS bundle")
    js = next((p for p in files if JS_PATH.fullmatch(p)), None)
    require(js is not None, "Unexpected site paths")
    html = files["index.html"].decode("utf-8")
    modules = re.findall(r'<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"[^>]*>', html)
    require(modules == [BASE + js], "HTML module reference does not match the bundled asset")
    require('<div id="root"></div>' in html, "App root is absent")


def site_files(root):
    require(root.is_dir() and not root.is_symlink(), "Site directory is missing")
    files = {}
    for path in root.rglob("*"):
        require(not path.is_symlink(), "Symlinks are not allowed")
        if path.is_file():
            files[path.relative_to(root).as_posix()] = read_limited(path)
    check_site(files)
    return files


def canonical_tar(entries):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        for name, data in sorted(entries.items()):
            info = tarfile.TarInfo(name)
            info.size, info.mode, info.mtime = len(data), 0o644, 0
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            archive.addfile(info, io.BytesIO(data))
    return output.getvalue()


def pack(root, kind, commit, out):
    require(SHA1.fullmatch(commit), "Expected a full lower-case source commit SHA")
    if kind == "candidate":
        require(commit == CANDIDATE_COMMIT, "Candidate source commit is not the reviewed pilot")
    files = site_files(root)
    if kind == "rollback":
        require(commit == BASELINE_COMMIT, "Rollback source commit changed")
        require({p: digest(b) for p, b in files.items()} == BASELINE_FILES, "Rollback bytes differ from the observed production version")
    manifest = {
        "schema": "sales-pages-pilot/v1", "repository": REPOSITORY,
        "kind": kind, "source_commit": commit, "origin": ORIGIN, "base": BASE,
        "exclusions": EXCLUSIONS,
        "files": {p: {"bytes": len(b), "sha256": digest(b)} for p, b in sorted(files.items())},
    }
    entries = {"site/" + p: b for p, b in files.items()}
    entries["manifest.json"] = (json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode()
    data = canonical_tar(entries)
    require(not out.exists(), "Bundle output already exists")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(data)
    return {"kind": kind, "bundle_sha256": digest(data), "source_commit": commit, "files": manifest["files"]}


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "Duplicate JSON key")
        result[key] = value
    return result


def verify(bundle, expected_hash, kind, commit):
    require(SHA256.fullmatch(expected_hash), "Expected a full lower-case SHA-256")
    require(SHA1.fullmatch(commit), "Expected a full lower-case source commit SHA")
    if kind == "candidate":
        require(commit == CANDIDATE_COMMIT, "Candidate source commit is not the reviewed pilot")
    require(bundle.is_file() and not bundle.is_symlink() and bundle.stat().st_size <= MAX_BUNDLE, "Invalid bundle file")
    data = bundle.read_bytes()
    require(digest(data) == expected_hash, "Bundle SHA-256 mismatch")
    entries = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:") as archive:
        for member in archive:
            require(member.isfile() and not member.issym() and not member.islnk(), "Non-regular archive entry")
            name = member.name
            allowed = name in {"manifest.json", "site/index.html"} or (name.startswith("site/") and JS_PATH.fullmatch(name[5:]))
            require(allowed and name not in entries, "Unexpected or duplicate archive path")
            require(0 <= member.size <= MAX_FILE, "Archive entry exceeds limit")
            entries[name] = archive.extractfile(member).read()
    require(len(entries) == 3 and "manifest.json" in entries, "Bundle must contain exactly three files")
    manifest = json.loads(entries.pop("manifest.json"), object_pairs_hook=unique_object)
    require(set(manifest) == {"schema", "repository", "kind", "source_commit", "origin", "base", "exclusions", "files"}, "Unexpected manifest fields")
    require(manifest["schema"] == "sales-pages-pilot/v1" and manifest["repository"] == REPOSITORY, "Manifest identity mismatch")
    require(manifest["kind"] == kind and manifest["source_commit"] == commit, "Manifest kind/source mismatch")
    require(manifest["origin"] == ORIGIN and manifest["base"] == BASE and manifest["exclusions"] == EXCLUSIONS, "Manifest scope mismatch")
    files = {p[5:]: b for p, b in entries.items()}
    check_site(files)
    actual = {p: {"bytes": len(b), "sha256": digest(b)} for p, b in sorted(files.items())}
    require(manifest["files"] == actual, "Manifest file hash/size mismatch")
    if kind == "rollback":
        require(commit == BASELINE_COMMIT and {p: digest(b) for p, b in files.items()} == BASELINE_FILES, "Rollback identity mismatch")
    return manifest, files


def api_json(url, token):
    require(url.startswith("https://api.github.com/repos/" + REPOSITORY + "/"), "Unexpected API origin/path")
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"})
    with urllib.request.build_opener(NoRedirect).open(req, timeout=20) as response:
        data = response.read(MAX_FILE + 1)
    require(len(data) <= MAX_FILE, "API response exceeds limit")
    return json.loads(data)


def provenance(run_id, workflow_sha):
    require(re.fullmatch(r"[1-9][0-9]*", run_id), "Invalid source run ID")
    require(SHA1.fullmatch(workflow_sha), "Invalid workflow SHA")
    token = os.environ.get("GH_TOKEN", "")
    require(bool(token), "Ephemeral GitHub token is missing")
    api = "https://api.github.com/repos/" + REPOSITORY
    run = api_json(api + "/actions/runs/" + run_id, token)
    require(run.get("repository", {}).get("full_name") == REPOSITORY, "Run repository mismatch")
    require(run.get("event") == "workflow_dispatch" and run.get("head_branch") == "main", "Run event/branch mismatch")
    require(run.get("path") == ".github/workflows/deploy.yml" and run.get("head_sha") == workflow_sha, "Run workflow revision mismatch")
    require(run.get("status") == "completed" and run.get("conclusion") == "success", "Preparation run did not succeed")
    jobs = api_json(api + "/actions/runs/" + run_id + "/jobs?per_page=100", token)
    require(any(j.get("name") == "prepare" and j.get("conclusion") == "success" for j in jobs.get("jobs", [])), "Run lacks successful preparation job")
    main = api_json(api + "/git/ref/heads/main", token)
    require(main.get("object", {}).get("sha") == workflow_sha, "Main moved since the selected workflow revision")
    return {"preparation_run_id": run_id, "workflow_commit": workflow_sha, "verified": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    capture = sub.add_parser("capture")
    capture.add_argument("--out", type=Path, required=True)
    package = sub.add_parser("pack")
    package.add_argument("--site", type=Path, required=True)
    package.add_argument("--out", type=Path, required=True)
    package.add_argument("--kind", choices=["candidate", "rollback"], required=True)
    package.add_argument("--commit", required=True)
    for command in ["verify", "extract", "check-live"]:
        p = sub.add_parser(command)
        p.add_argument("--bundle", type=Path, required=True)
        p.add_argument("--sha256", required=True)
        p.add_argument("--kind", choices=["candidate", "rollback"], required=True)
        p.add_argument("--commit", required=True)
        if command == "extract":
            p.add_argument("--out", type=Path, required=True)
    p = sub.add_parser("check-current")
    p.add_argument("--index-sha256", required=True)
    p = sub.add_parser("provenance")
    p.add_argument("--run-id", required=True)
    p.add_argument("--workflow-sha", required=True)
    args = parser.parse_args()
    if args.command == "capture":
        require(not args.out.exists(), "Recovery output already exists")
        files = {p: public_bytes(p) for p in BASELINE_FILES}
        require({p: digest(b) for p, b in files.items()} == BASELINE_FILES, "Production changed; refuse to capture a different baseline")
        check_site(files)
        for p, data in files.items():
            dest = args.out / p
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
        result = {"captured": BASELINE_FILES, "origin": ORIGIN, "base": BASE}
    elif args.command == "pack":
        result = pack(args.site, args.kind, args.commit, args.out)
    elif args.command == "check-current":
        require(SHA256.fullmatch(args.index_sha256), "Invalid current index SHA-256")
        require(digest(public_bytes("index.html")) == args.index_sha256, "Production changed; refusing to overwrite an unexpected version")
        result = {"current_index_matches": True}
    elif args.command == "provenance":
        result = provenance(args.run_id, args.workflow_sha)
    else:
        manifest, files = verify(args.bundle, args.sha256, args.kind, args.commit)
        if args.command == "extract":
            require(not args.out.exists(), "Extraction output already exists")
            for p, data in files.items():
                dest = args.out / p
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(data)
        elif args.command == "check-live":
            for p, data in files.items():
                require(digest(public_bytes(p)) == digest(data), "Published hash mismatch: " + p)
        result = {"verified": True, "command": args.command, "manifest": manifest}
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, json.JSONDecodeError, tarfile.TarError, urllib.error.URLError) as error:
        print("Pilot rejected: " + str(error), file=sys.stderr)
        sys.exit(1)
