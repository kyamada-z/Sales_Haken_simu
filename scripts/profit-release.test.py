#!/usr/bin/env python3
"""Offline rejection tests using real Git trees and mocked GitHub responses only."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location("profit_release", Path(__file__).with_name("profit-release.py"))
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


def git(repo, *args, input=None):
    return subprocess.check_output(
        ["git", "-C", str(repo), *args], input=input, stderr=subprocess.PIPE,
        env={**os.environ, "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull},
    ).decode().strip()


def put(repo, name, text):
    path = repo / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


class ReleaseGuards(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.repo = self.root / "main"
        self.repo.mkdir()
        git(self.repo, "init", "-q", "-b", "main")
        git(self.repo, "config", "user.name", "Release fixture")
        git(self.repo, "config", "user.email", "fixture@example.invalid")
        put(self.repo, "README.md", "Existing protected release fixture\n")
        self.old = self.commit("old main")
        put(self.repo, "src/App.jsx", "reviewed profit feature\n")
        self.feature = self.commit("reviewed feature")
        self.template = "name: exact-release\nenv:\n  RELEASE_TOOLS_SHA: @RELEASE_TOOLS_SHA@\n"
        for name in release.RELEASE_ADDITIONS - {release.WORKFLOW}:
            put(self.repo, name, self.template if name == release.TEMPLATE else "release fixture\n")
        self.tools_sha = self.commit("reviewed release helpers")
        self.tools = self.root / "tools"
        git(self.root, "clone", "-q", str(self.repo), str(self.tools))
        self.candidate = self.root / "candidate"
        git(self.root, "clone", "-q", str(self.repo), str(self.candidate))
        git(self.candidate, "checkout", "-q", "--detach", self.feature)
        self.trusted = self.root / "trusted"
        git(self.root, "clone", "-q", str(self.repo), str(self.trusted))
        git(self.trusted, "checkout", "-q", "--detach", self.old)
        self.head = self.make_head()
        self.event_path = self.root / "event.json"
        self.event = {
            "before": self.old, "after": self.head, "head_commit": {"id": self.head},
            "ref": "refs/heads/main", "repository": {"full_name": release.REPOSITORY},
            "forced": False, "created": False, "deleted": False,
        }
        self.event_path.write_text(json.dumps(self.event))
        self.env = {
            "GITHUB_SHA": self.head, "RELEASE_TOOLS_SHA": self.tools_sha,
            "GITHUB_EVENT_NAME": "push", "GITHUB_REPOSITORY": release.REPOSITORY,
            "GITHUB_REF": "refs/heads/main", "GITHUB_WORKFLOW_SHA": self.head,
            "GITHUB_WORKFLOW_REF": release.REPOSITORY + "/" + release.WORKFLOW + "@refs/heads/main",
            "GITHUB_EVENT_PATH": str(self.event_path), "GITHUB_RUN_ID": "12345", "GITHUB_RUN_ATTEMPT": "1",
        }
        self.current_run = {
            "head_sha": self.head, "head_branch": "main", "event": "push", "path": release.WORKFLOW,
            "run_attempt": 1, "repository": {"full_name": release.REPOSITORY},
        }
        self.remote_main = self.head
        self.old_run = {
            "status": "completed", "conclusion": "success", "head_sha": self.old, "head_branch": "main",
            "event": "push", "run_attempt": 1, "repository": {"full_name": release.REPOSITORY},
            "path": ".github/workflows/pages-auto-release.yml",
        }
        self.old_artifact = {
            "name": release.OLD_ARTIFACT_NAME, "expired": False, "size_in_bytes": 1000,
            "workflow_run": {"id": release.OLD_RUN, "head_sha": self.old, "head_branch": "main", "repository_id": 1241342773},
        }
        for name, value in {"OLD_MAIN": self.old, "FEATURE": self.feature, "TRUSTED": self.old, "ROOT": self.tools}.items():
            self.enterContext(patch.object(release, name, value))
        self.enterContext(patch.dict(os.environ, self.env))
        self.enterContext(patch.object(release, "api", self.api))

    def commit(self, message):
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-q", "-m", message)
        return git(self.repo, "rev-parse", "HEAD")

    def make_head(self):
        git(self.repo, "reset", "--hard", self.tools_sha)
        put(self.repo, release.WORKFLOW, self.template.replace("@RELEASE_TOOLS_SHA@", self.tools_sha))
        git(self.repo, "add", ".")
        tree = git(self.repo, "write-tree")
        head = git(self.repo, "commit-tree", tree, "-p", self.old, "-p", self.tools_sha, input=b"one authorized release\n")
        git(self.repo, "reset", "--hard", head)
        return head

    def api(self, path):
        responses = {
            "/actions/runs/12345": self.current_run,
            "/git/ref/heads/main": {"object": {"sha": self.remote_main}},
            "/actions/runs/" + str(release.OLD_RUN): self.old_run,
            "/actions/runs/" + str(release.OLD_RUN) + "/jobs?per_page=100": {"jobs": [{"name": "release", "conclusion": "success"}]},
            "/actions/artifacts/" + str(release.OLD_ARTIFACT): self.old_artifact,
        }
        if path not in responses:
            raise AssertionError("Unexpected API request: " + path)
        return copy.deepcopy(responses[path])

    def authorize(self):
        return release.guard(self.repo, self.trusted, self.candidate)

    def update_head_identity(self, head):
        self.head = head
        self.event.update(after=head, head_commit={"id": head})
        self.event_path.write_text(json.dumps(self.event))
        os.environ.update(GITHUB_SHA=head, GITHUB_WORKFLOW_SHA=head)
        self.current_run["head_sha"] = head
        self.remote_main = head

    def test_exact_reviewed_transition_and_previous_artifact_pass(self):
        self.assertTrue(self.authorize()["authorized"])
        self.assertEqual(release.previous(self.trusted)["source_commit"], self.old)

    def test_malformed_sha_is_rejected(self):
        os.environ["GITHUB_SHA"] = "main"
        with self.assertRaisesRegex(ValueError, "Full SHA required"):
            self.authorize()

    def test_arbitrary_full_candidate_sha_is_rejected(self):
        git(self.candidate, "checkout", "-q", "--detach", self.tools_sha)
        with self.assertRaisesRegex(ValueError, "Checkout identity changed"):
            self.authorize()

    def test_main_movement_prevents_publication_or_recovery(self):
        self.remote_main = "a" * 40
        with self.assertRaisesRegex(ValueError, "Main moved"):
            self.authorize()

    def test_other_committed_main_tree_is_rejected(self):
        put(self.repo, "src/App.jsx", "unreviewed change\n")
        git(self.repo, "add", ".")
        head = git(self.repo, "commit-tree", git(self.repo, "write-tree"), "-p", self.old, "-p", self.tools_sha, input=b"different tree\n")
        git(self.repo, "reset", "--hard", head)
        self.update_head_identity(head)
        with self.assertRaisesRegex(ValueError, "Main differs from exact reviewed release tree"):
            self.authorize()

    def test_unlisted_release_addition_is_rejected(self):
        git(self.repo, "reset", "--hard", self.tools_sha)
        put(self.repo, "unexpected.txt", "outside the allowed one-time release scope\n")
        self.tools_sha = self.commit("unreviewed helper addition")
        git(self.tools, "fetch", "-q", str(self.repo), self.tools_sha)
        git(self.tools, "reset", "--hard", self.tools_sha)
        os.environ["RELEASE_TOOLS_SHA"] = self.tools_sha
        self.update_head_identity(self.make_head())
        with self.assertRaisesRegex(ValueError, "Unexpected release addition or deletion"):
            self.authorize()

    def test_tracked_candidate_bytes_cannot_change_after_checkout(self):
        put(self.candidate, "src/App.jsx", "changed after verification\n")
        with self.assertRaisesRegex(ValueError, "Bytes changed"):
            self.authorize()

    def test_forced_push_is_rejected(self):
        self.event["forced"] = True
        self.event_path.write_text(json.dumps(self.event))
        with self.assertRaisesRegex(ValueError, "Forced/deleted/new ref forbidden"):
            self.authorize()

    def test_old_artifact_provenance_must_match_all_bound_identifiers(self):
        valid = copy.deepcopy(self.old_artifact["workflow_run"])
        for field, bad_value in [("id", release.OLD_RUN + 1), ("head_sha", "b" * 40), ("head_branch", "other"), ("repository_id", 1)]:
            with self.subTest(field=field):
                self.old_artifact["workflow_run"] = {**valid, field: bad_value}
                with self.assertRaisesRegex(ValueError, "Artifact provenance mismatch"):
                    release.previous(self.trusted)

    def test_expired_recovery_artifact_is_rejected(self):
        self.old_artifact["expired"] = True
        with self.assertRaisesRegex(ValueError, "Old artifact identity/expiry mismatch"):
            release.previous(self.trusted)

    def test_failed_previous_release_is_rejected(self):
        self.old_run["conclusion"] = "failure"
        with self.assertRaisesRegex(ValueError, "Old release not successful"):
            release.previous(self.trusted)


if __name__ == "__main__":
    unittest.main(verbosity=2)
