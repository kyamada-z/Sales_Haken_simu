#!/usr/bin/env python3
"""Exact Sales artifacts: bundled CSS candidates and legacy recovery bytes.

The original archive primitive remains unchanged. This module extends only the
reviewed path/layout boundary, retaining its limits, redirect guard and hashes.
"""
import importlib.util
from pathlib import Path
import re
import urllib.request

spec = importlib.util.spec_from_file_location("original_pilot", Path(__file__).with_name("security-pilot.py"))
original = importlib.util.module_from_spec(spec)
spec.loader.exec_module(original)
for name in ["REPOSITORY", "ORIGIN", "BASE", "MAX_FILE", "MAX_BUNDLE", "SHA256", "SHA1", "JS_PATH", "require", "digest", "read_limited", "NoRedirect", "canonical_tar", "unique_object", "api_json"]:
    globals()[name] = getattr(original, name)

CSS_PATH = re.compile(r"assets/index-[A-Za-z0-9_-]+\.css\Z")


def asset_path(path):
    return JS_PATH.fullmatch(path) or CSS_PATH.fullmatch(path)


def public_bytes(path):
    require(path == "index.html" or asset_path(path), "Unexpected public path")
    url = ORIGIN + BASE + ("" if path == "index.html" else path)
    req = urllib.request.Request(url, headers={"Cache-Control": "no-cache", "User-Agent": "Sales-bundled-artifact/2"})
    with urllib.request.build_opener(NoRedirect).open(req, timeout=20) as response:
        require(response.status == 200 and response.url == url, "Unexpected HTTP response")
        data = response.read(MAX_FILE + 1)
    require(len(data) <= MAX_FILE, "HTTP file exceeds limit")
    return data


def check_site(files, require_css=False):
    require(len(files) in [2, 3] and "index.html" in files, "Expected exactly HTML+JS, or HTML+JS+CSS")
    js = [path for path in files if JS_PATH.fullmatch(path)]
    css = [path for path in files if CSS_PATH.fullmatch(path)]
    require(len(js) == 1 and len(css) == len(files) - 2, "Unexpected site paths")
    require(set(files) == {"index.html", *js, *css}, "Unexpected site paths")
    require(not require_css or len(css) == 1, "New candidates require one bundled CSS asset")
    html = files["index.html"].decode("utf-8")
    modules = re.findall(r'<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"[^>]*>', html)
    require(modules == [BASE + js[0]], "HTML module reference does not match bundled asset")
    styles = re.findall(r'<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"[^>]*>', html)
    require(styles == [BASE + path for path in css], "HTML stylesheet reference does not match bundled asset")
    require('<div id="root"></div>' in html, "App root is absent")
    if css:
        require(len(re.findall(r"<script\b", html)) == 1 and "cdn.tailwindcss.com" not in html, "Bundled artifact must not contain runtime CDN scripts")
        require(len(re.findall(r"<link\b[^>]*\brel=\"stylesheet\"", html)) == 1, "Expected one stylesheet")


def site_files(root, require_css=False):
    require(root.is_dir() and not root.is_symlink(), "Site directory is missing")
    files = {}
    for path in root.rglob("*"):
        require(not path.is_symlink(), "Symlinks are not allowed")
        if path.is_file():
            files[path.relative_to(root).as_posix()] = read_limited(path)
    check_site(files, require_css=require_css)
    return files
