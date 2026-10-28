#!/usr/bin/env python3
"""Offline tests: no HTTP calls or deployment operations."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("pilot", Path(__file__).with_name("security-pilot.py"))
pilot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pilot)


class PilotTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.site = self.root / "site"
        (self.site / "assets").mkdir(parents=True)
        (self.site / "index.html").write_text('<script type="module" src="/Sales_Haken_simu/assets/index-test.js"></script><div id="root"></div>\n')
        (self.site / "assets/index-test.js").write_text('console.log("synthetic fixture");\n')
        self.commit = pilot.CANDIDATE_COMMIT
        self.bundle = self.root / "site-bundle.tar"
        self.summary = pilot.pack(self.site, "candidate", self.commit, self.bundle)

    def tearDown(self):
        self.tmp.cleanup()

    def verify(self, bundle=None, expected=None, kind="candidate", commit=None):
        return pilot.verify(bundle or self.bundle, expected or self.summary["bundle_sha256"], kind, commit or self.commit)

    def rewrite(self, changes=None, extra=None):
        entries = {}
        with tarfile.open(self.bundle, "r:") as archive:
            for entry in archive:
                entries[entry.name] = archive.extractfile(entry).read()
        entries.update(changes or {})
        entries.update(extra or {})
        path = self.root / "tampered.tar"
        data = pilot.canonical_tar(entries)
        path.write_bytes(data)
        return path, pilot.digest(data)

    def test_valid_bundle_round_trip(self):
        manifest, files = self.verify()
        self.assertEqual(manifest["source_commit"], self.commit)
        self.assertEqual(files, pilot.site_files(self.site))

    def test_pack_is_deterministic(self):
        other = self.root / "second.tar"
        summary = pilot.pack(self.site, "candidate", self.commit, other)
        self.assertEqual(summary["bundle_sha256"], self.summary["bundle_sha256"])
        self.assertEqual(other.read_bytes(), self.bundle.read_bytes())

    def test_wrong_outer_hash_rejected(self):
        with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
            self.verify(expected="0" * 64)

    def test_wrong_source_commit_rejected(self):
        with self.assertRaisesRegex(ValueError, "not the reviewed pilot"):
            self.verify(commit="b" * 40)

    def test_unreviewed_candidate_cannot_be_packed(self):
        with self.assertRaisesRegex(ValueError, "not the reviewed pilot"):
            pilot.pack(self.site, "candidate", "a" * 40, self.root / "unreviewed.tar")
        self.assertFalse((self.root / "unreviewed.tar").exists())

    def test_wrong_kind_rejected(self):
        with self.assertRaisesRegex(ValueError, "kind/source mismatch"):
            self.verify(kind="rollback")

    def test_changed_asset_rejected_even_with_matching_new_outer_hash(self):
        altered, expected = self.rewrite({"site/assets/index-test.js": b"changed"})
        with self.assertRaisesRegex(ValueError, "file hash/size mismatch"):
            self.verify(altered, expected)

    def test_traversal_archive_rejected(self):
        altered, expected = self.rewrite(extra={"../outside": b"forbidden"})
        with self.assertRaisesRegex(ValueError, "archive path"):
            self.verify(altered, expected)
        self.assertFalse((self.root.parent / "outside").exists())

    def test_duplicate_archive_member_rejected(self):
        data = self.bundle.read_bytes()
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode="w") as archive:
            with tarfile.open(fileobj=io.BytesIO(data), mode="r:") as source:
                for entry in source:
                    value = source.extractfile(entry).read()
                    archive.addfile(entry, io.BytesIO(value))
                    if entry.name == "site/index.html":
                        archive.addfile(entry, io.BytesIO(value))
        altered = self.root / "duplicate.tar"
        altered.write_bytes(output.getvalue())
        with self.assertRaisesRegex(ValueError, "duplicate archive path"):
            self.verify(altered, pilot.digest(output.getvalue()))

    def test_symlink_member_rejected(self):
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode="w") as archive:
            entry = tarfile.TarInfo("site/index.html")
            entry.type, entry.linkname = tarfile.SYMTYPE, "/tmp/outside"
            archive.addfile(entry)
        altered = self.root / "symlink.tar"
        altered.write_bytes(output.getvalue())
        with self.assertRaisesRegex(ValueError, "Non-regular archive entry"):
            self.verify(altered, pilot.digest(output.getvalue()))

    def test_html_asset_disagreement_rejected(self):
        (self.site / "index.html").write_text('<script type="module" src="/wrong.js"></script><div id="root"></div>')
        with self.assertRaisesRegex(ValueError, "module reference"):
            pilot.pack(self.site, "candidate", self.commit, self.root / "wrong.tar")

    def test_false_rollback_bytes_rejected(self):
        with self.assertRaisesRegex(ValueError, "observed production version"):
            pilot.pack(self.site, "rollback", pilot.BASELINE_COMMIT, self.root / "false-rollback.tar")

    def test_unexpected_extra_site_file_rejected(self):
        (self.site / "unexpected.txt").write_text("must not be silently omitted")
        with self.assertRaisesRegex(ValueError, "exactly one JS bundle"):
            pilot.pack(self.site, "candidate", self.commit, self.root / "extra.tar")

    def test_invalid_source_run_rejected_without_network(self):
        with patch.object(pilot, "api_json", side_effect=AssertionError("Network must not run")):
            with self.assertRaisesRegex(ValueError, "source run ID"):
                pilot.provenance("../../123", self.commit)

    def test_moved_main_rejected(self):
        run = {"repository": {"full_name": pilot.REPOSITORY}, "event": "workflow_dispatch", "head_branch": "main", "path": ".github/workflows/deploy.yml", "head_sha": self.commit, "status": "completed", "conclusion": "success"}
        jobs = {"jobs": [{"name": "prepare", "conclusion": "success"}]}
        with patch.dict("os.environ", {"GH_TOKEN": "synthetic-ephemeral-fixture"}):
            with patch.object(pilot, "api_json", side_effect=[run, jobs, {"object": {"sha": "b" * 40}}]):
                with self.assertRaisesRegex(ValueError, "Main moved"):
                    pilot.provenance("123", self.commit)

    def test_successful_prepare_provenance(self):
        run = {"repository": {"full_name": pilot.REPOSITORY}, "event": "workflow_dispatch", "head_branch": "main", "path": ".github/workflows/deploy.yml", "head_sha": self.commit, "status": "completed", "conclusion": "success"}
        jobs = {"jobs": [{"name": "prepare", "conclusion": "success"}]}
        with patch.dict("os.environ", {"GH_TOKEN": "synthetic-ephemeral-fixture"}):
            with patch.object(pilot, "api_json", side_effect=[run, jobs, {"object": {"sha": self.commit}}]):
                self.assertTrue(pilot.provenance("123", self.commit)["verified"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
