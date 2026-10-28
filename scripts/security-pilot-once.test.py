#!/usr/bin/env python3
"""Offline provenance, race, fixture and recovery rejection tests; never deploys."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("once", Path(__file__).with_name("security-pilot-once.py"))
once = importlib.util.module_from_spec(spec)
spec.loader.exec_module(once)
pilot = once.pilot


class OnceTests(unittest.TestCase):
    def setUp(self):
        self.sha = "a" * 40
        self.env = {"GITHUB_EVENT_NAME": "push", "GITHUB_REPOSITORY": pilot.REPOSITORY,
                    "GITHUB_REF": "refs/heads/main", "GITHUB_SHA": self.sha,
                    "GITHUB_WORKFLOW_SHA": self.sha,
                    "GITHUB_WORKFLOW_REF": pilot.REPOSITORY + "/" + once.WORKFLOW + "@refs/heads/main",
                    "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "2", "GH_TOKEN": "synthetic-fixture"}
        self.event = {"repository": {"full_name": pilot.REPOSITORY}, "ref": "refs/heads/main",
                      "before": once.BEFORE, "after": self.sha, "head_commit": {"id": self.sha},
                      "created": False, "deleted": False, "forced": False}
        self.run = {"repository": {"full_name": pilot.REPOSITORY}, "event": "push", "head_branch": "main",
                    "path": once.WORKFLOW, "head_sha": self.sha, "run_attempt": 2}
        self.commit = {"sha": self.sha, "parents": [{"sha": once.BEFORE}],
                       "files": [{"filename": p, "status": s} for p, s in once.CHANGES.items()]}
        self.main = {"object": {"sha": self.sha}}

    def verify(self):
        with patch.object(pilot, "api_json", side_effect=[self.run, self.commit, self.main]):
            return once.guard(self.event, self.env)

    def test_exact_single_authorized_push_accepted(self):
        self.assertTrue(self.verify()["verified"])

    def test_future_push_predecessor_rejected_before_network(self):
        self.event["before"] = self.sha
        with patch.object(pilot, "api_json", side_effect=AssertionError("Network forbidden")):
            with self.assertRaisesRegex(ValueError, "predecessor"):
                once.guard(self.event, self.env)

    def test_manual_dispatch_and_other_repository_rejected(self):
        for field, value in [("GITHUB_EVENT_NAME", "workflow_dispatch"), ("GITHUB_REPOSITORY", "other/repo"),
                             ("GITHUB_REF", "refs/heads/feature"), ("GITHUB_WORKFLOW_SHA", "b" * 40),
                             ("GITHUB_RUN_ID", "../1"), ("GITHUB_RUN_ATTEMPT", "0")]:
            with self.subTest(field=field):
                env = {**self.env, field: value}
                with self.assertRaises(ValueError):
                    once.event_identity(self.event, env)

    def test_forced_created_deleted_or_missing_flags_rejected(self):
        for flag in ["forced", "created", "deleted"]:
            for value in [True, None, "false"]:
                event = {**self.event, flag: value}
                with self.subTest(flag=flag, value=value), self.assertRaises(ValueError):
                    once.event_identity(event, self.env)

    def test_event_head_or_repository_mismatch_rejected(self):
        for field, value in [("after", "b" * 40), ("head_commit", {"id": "b" * 40}), ("repository", {"full_name": "other/repo"})]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                once.event_identity({**self.event, field: value}, self.env)

    def test_wrong_workflow_path_rejected(self):
        self.run["path"] = ".github/workflows/deploy.yml"
        with self.assertRaisesRegex(ValueError, "workflow/head/attempt"):
            self.verify()

    def test_stale_run_attempt_rejected(self):
        self.run["run_attempt"] = 1
        with self.assertRaisesRegex(ValueError, "workflow/head/attempt"):
            self.verify()

    def test_run_origin_and_event_rejected(self):
        for field, value in [("event", "workflow_dispatch"), ("head_branch", "feature"), ("repository", {"full_name": "other/repo"})]:
            original = copy.deepcopy(self.run)
            self.run[field] = value
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "repository/event/branch"):
                self.verify()
            self.run = original

    def test_multi_commit_or_merge_push_rejected(self):
        for parents in [[{"sha": "b" * 40}], [{"sha": once.BEFORE}, {"sha": "c" * 40}], []]:
            self.commit["parents"] = parents
            with self.subTest(parents=parents), self.assertRaisesRegex(ValueError, "direct child"):
                self.verify()

    def test_unapproved_app_or_dependency_path_rejected(self):
        for name in ["src/App.jsx", "package.json", "package-lock.json", "scripts/security-policy.mjs"]:
            self.commit["files"][-1] = {"filename": name, "status": "modified"}
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "unapproved paths"):
                self.verify()

    def test_extra_or_missing_file_rejected(self):
        self.commit["files"].append({"filename": "extra.txt", "status": "added"})
        with self.assertRaisesRegex(ValueError, "unapproved paths"):
            self.verify()
        self.commit["files"] = self.commit["files"][:2]
        with self.assertRaisesRegex(ValueError, "unapproved paths"):
            self.verify()

    def test_rename_or_delete_rejected(self):
        self.commit["files"][0]["status"] = "removed"
        with self.assertRaisesRegex(ValueError, "unapproved paths"):
            self.verify()
        self.commit["files"][0]["status"] = "added"
        self.commit["files"][0]["previous_filename"] = "old.yml"
        with self.assertRaisesRegex(ValueError, "Renames"):
            self.verify()

    def test_main_update_race_rejected(self):
        self.main["object"]["sha"] = "b" * 40
        with self.assertRaisesRegex(ValueError, "Main moved"):
            self.verify()

    def test_no_token_rejected(self):
        self.env["GH_TOKEN"] = ""
        with self.assertRaisesRegex(ValueError, "token"):
            self.verify()

    def test_tooling_has_one_exact_integrity_pinned_official_dependency(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "tooling"
            once.tooling(out)
            package = json.loads((out / "package.json").read_text())
            lock = json.loads((out / "package-lock.json").read_text())
            self.assertEqual(package["dependencies"], {"playwright-core": "1.56.1"})
            self.assertEqual(set(lock["packages"]), {"", "node_modules/playwright-core"})
            dependency = lock["packages"]["node_modules/playwright-core"]
            self.assertEqual(dependency["integrity"], once.INTEGRITY)
            self.assertEqual(dependency["resolved"], "https://registry.npmjs.org/playwright-core/-/playwright-core-1.56.1.tgz")
            with self.assertRaisesRegex(ValueError, "already exists"):
                once.tooling(out)


class KnownVersionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.files = {}
        self.paths = {}
        self.hashes = {}
        for kind in ["candidate", "rollback"]:
            site = root / kind
            (site / "assets").mkdir(parents=True)
            files = {"index.html": f'<script type="module" src="/Sales_Haken_simu/assets/index-{kind}.js"></script><div id="root"></div>'.encode(),
                     f"assets/index-{kind}.js": ("synthetic " + kind).encode()}
            self.files[kind] = files
            for p, data in files.items():
                (site / p).write_bytes(data)
            bundle = root / (kind + ".tar")
            with patch.object(pilot, "BASELINE_FILES", {p: pilot.digest(b) for p, b in self.files.get("rollback", {}).items()}):
                summary = pilot.pack(site, kind, pilot.CANDIDATE_COMMIT if kind == "candidate" else pilot.BASELINE_COMMIT, bundle)
            self.paths[kind] = bundle
            self.hashes[kind] = summary["bundle_sha256"]
        self.baseline = patch.object(pilot, "BASELINE_FILES", {p: pilot.digest(b) for p, b in self.files["rollback"].items()})
        self.baseline.start()

    def tearDown(self):
        self.baseline.stop()
        self.tmp.cleanup()

    def check(self, live, allowed):
        with patch.object(pilot, "public_bytes", side_effect=lambda path: live[path]):
            return once.known_live(self.paths["candidate"], self.hashes["candidate"], self.paths["rollback"], self.hashes["rollback"], allowed)

    def test_exact_rollback_and_candidate_recognized_for_recovery(self):
        for kind in ["candidate", "rollback"]:
            self.assertEqual(self.check(self.files[kind], ["candidate", "rollback"])["known_live"], kind)

    def test_initial_release_will_not_overwrite_candidate_or_unknown(self):
        for live in [self.files["candidate"], {"index.html": b"external update"}]:
            with self.assertRaisesRegex(ValueError, "not an allowed exact version"):
                self.check(live, ["rollback"])

    def test_known_html_but_changed_js_will_not_be_overwritten(self):
        live = {**self.files["candidate"], "assets/index-candidate.js": b"different"}
        with self.assertRaisesRegex(ValueError, "unexpected JS"):
            self.check(live, ["candidate", "rollback"])

    def test_tampered_bundle_fails_before_any_live_read(self):
        self.hashes["candidate"] = "0" * 64
        with patch.object(pilot, "public_bytes", side_effect=AssertionError("Must not read live")):
            with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
                once.known_live(self.paths["candidate"], self.hashes["candidate"], self.paths["rollback"], self.hashes["rollback"], ["candidate"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
