#!/usr/bin/env python3
"""Offline synthetic Git/archive/provenance fixtures. No HTTP or deployment."""
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("auto", Path(__file__).with_name("security-auto-release.py"))
auto = importlib.util.module_from_spec(spec); spec.loader.exec_module(auto)


class GitBoundaries(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.repo = Path(self.tmp.name)
        self.gitcmd("init", "-b", "main"); self.gitcmd("config", "user.name", "Synthetic Fixture"); self.gitcmd("config", "user.email", "fixture@example.invalid")
        self.write("package.json", '{"name":"fixture","dependencies":{"react":"18.3.1"}}\n')
        self.write("package-lock.json", '{"lockfileVersion":3}\n'); self.write("src/App.jsx", "synthetic baseline\n")
        self.write(".github/workflows/security-verify.yml", "synthetic original CI\n")
        self.baseline = self.commit("synthetic baseline")
        self.pin = patch.object(auto, "TRUSTED", self.baseline); self.pin.start()
        for path in auto.ACTIVATION_PATHS: self.write(path, "synthetic activation " + path + "\n")
        self.write(".github/workflows/security-verify.yml", "synthetic scoped legacy PR skip\n")
        self.activation = self.commit("synthetic activation")

    def tearDown(self): self.pin.stop(); self.tmp.cleanup()
    def gitcmd(self, *args): return subprocess.check_output(["git", "-C", str(self.repo), *args], stderr=subprocess.PIPE).decode().strip()
    def write(self, path, value): p = self.repo / path; p.parent.mkdir(parents=True, exist_ok=True); p.write_text(value)
    def commit(self, message): self.gitcmd("add", "."); self.gitcmd("commit", "-m", message); return self.gitcmd("rev-parse", "HEAD")
    def dependency(self): self.write("package-lock.json", '{"lockfileVersion":3,"synthetic":1}\n'); return self.commit("synthetic dependency update")
    def event(self, before, head): return {"repository":{"full_name":auto.pilot.REPOSITORY},"ref":"refs/heads/main","before":before,"after":head,"head_commit":{"id":head},"forced":False,"created":False,"deleted":False}
    def env(self, head): return {"GITHUB_EVENT_NAME":"push","GITHUB_REPOSITORY":auto.pilot.REPOSITORY,"GITHUB_REF":"refs/heads/main","GITHUB_SHA":head,"GITHUB_WORKFLOW_SHA":head,"GITHUB_WORKFLOW_REF":auto.pilot.REPOSITORY+"/"+auto.WORKFLOW+"@refs/heads/main","GITHUB_RUN_ID":"123","GITHUB_RUN_ATTEMPT":"2","GH_TOKEN":"synthetic-test"}
    def guard(self, before, head, main=None):
        run={"repository":{"full_name":auto.pilot.REPOSITORY},"head_branch":"main","event":"push","path":auto.WORKFLOW,"head_sha":head,"run_attempt":2}
        with patch.object(auto,"api",side_effect=[run,{"object":{"sha":main or head}}]): return auto.event_guard(self.event(before,head),self.env(head),self.repo)

    def test_activation_is_read_only_setup(self):
        result=self.guard(self.baseline,self.activation)
        self.assertEqual(result["mode"],"setup"); self.assertFalse(result["eligible"])

    def test_read_only_setup_ci_can_test_revised_five_path_branch_tree(self):
        self.write(auto.WORKFLOW,"synthetic revised activation\n"); head=self.commit("setup fix")
        self.assertEqual(auto.assess(self.repo,self.baseline,head,True)["mode"],"setup")
        with self.assertRaisesRegex(ValueError,"drift"): self.guard(self.activation,head)

    def test_legitimate_lock_only_release_and_dynamic_source(self):
        head=self.dependency(); result=self.guard(self.activation,head)
        self.assertTrue(result["eligible"]); self.assertEqual(result["head"],head); self.assertEqual(result["activation"],self.activation)

    def test_two_package_files_are_eligible(self):
        self.write("package.json",'{"name":"fixture","dependencies":{"react":"18.3.2"}}\n')
        head=self.dependency(); self.assertEqual(set(auto.assess(self.repo,self.activation,head)["paths"]),auto.DEPENDENCIES)

    def test_no_change_and_non_package_change_rejected(self):
        with self.assertRaisesRegex(ValueError,"Only existing"): auto.assess(self.repo,self.activation,self.activation)
        self.write("src/App.jsx","different app\n"); head=self.commit("app change")
        with self.assertRaisesRegex(ValueError,"drift"): auto.assess(self.repo,self.activation,head)

    def test_prior_workflow_or_helper_drift_is_rejected_on_later_dependency_push(self):
        for path in [auto.WORKFLOW,"scripts/security-auto-release.py"]:
            self.gitcmd("reset","--hard",self.activation); self.write(path,"unapproved earlier change\n")
            prior=self.commit("unapproved prior automation edit"); head=self.dependency()
            with self.subTest(path=path), self.assertRaisesRegex(ValueError,"drift"): auto.assess(self.repo,prior,head)

    def test_dependency_deletion_or_rename_is_rejected(self):
        self.gitcmd("rm","package-lock.json"); head=self.commit("delete lock")
        with self.assertRaisesRegex(ValueError,"drift|Only existing"): auto.assess(self.repo,self.activation,head)

    def test_extra_file_at_activation_is_not_accepted(self):
        self.gitcmd("reset","--hard",self.baseline)
        for path in auto.ACTIVATION_PATHS: self.write(path,"synthetic\n")
        self.write(".github/workflows/security-verify.yml", "synthetic scoped legacy PR skip\n")
        self.write("unapproved.txt","extra\n"); activation=self.commit("bad activation"); head=self.dependency()
        with self.assertRaisesRegex(ValueError,"Activation changed"): auto.assess(self.repo,activation,head)

    def test_main_race_fails_before_any_publish(self):
        head=self.dependency()
        with self.assertRaisesRegex(ValueError,"Main moved"): self.guard(self.activation,head,"b"*40)

    def test_multi_commit_push_and_forced_push_are_rejected(self):
        first=self.dependency(); self.write("package.json",'{"synthetic":2}\n'); head=self.commit("second commit")
        with self.assertRaisesRegex(ValueError,"first-parent"): self.guard(self.activation,head)
        event=self.event(first,head); event["forced"]=True
        with self.assertRaisesRegex(ValueError,"Forced"): auto.event_guard(event,self.env(head),self.repo)

    def test_one_step_normal_merge_with_only_dependency_diff_is_accepted(self):
        self.gitcmd("checkout","-b","synthetic-feature"); feature=self.dependency()
        self.gitcmd("checkout","main"); self.gitcmd("merge","--no-ff","synthetic-feature","-m","synthetic merge")
        head=self.gitcmd("rev-parse","HEAD")
        self.assertEqual(len(self.gitcmd("show","-s","--format=%P",head).split()),2)
        self.assertTrue(self.guard(self.activation,head)["eligible"])

    def test_wrong_workflow_and_run_attempt_are_rejected(self):
        head=self.dependency(); event=self.event(self.activation,head); env=self.env(head)
        env["GITHUB_WORKFLOW_SHA"]="b"*40
        with self.assertRaisesRegex(ValueError,"Workflow identity"): auto.event_guard(event,env,self.repo)
        run={"repository":{"full_name":auto.pilot.REPOSITORY},"head_branch":"main","event":"push","path":auto.WORKFLOW,"head_sha":head,"run_attempt":1}
        with patch.object(auto,"api",return_value=run), self.assertRaisesRegex(ValueError,"attempt"): auto.event_guard(event,self.env(head),self.repo)


class BundleBoundaries(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.root=Path(self.tmp.name); self.site=self.root/"site"
        (self.site/"assets").mkdir(parents=True)
        (self.site/"index.html").write_text('<script type="module" src="/Sales_Haken_simu/assets/index-test.js"></script><div id="root"></div>')
        (self.site/"assets/index-test.js").write_text('synthetic test bytes')
        self.bundle=self.root/"bundle.tar"; self.summary=auto.pack(self.site,"candidate","a"*40,self.bundle)

    def tearDown(self): self.tmp.cleanup()
    def rewrite(self, extra=None, change_manifest=None):
        entries={}
        with tarfile.open(self.bundle,"r:") as archive:
            for entry in archive: entries[entry.name]=archive.extractfile(entry).read()
        if change_manifest:
            manifest=json.loads(entries["manifest.json"]); change_manifest(manifest); entries["manifest.json"]=json.dumps(manifest).encode()
        entries.update(extra or {}); data=auto.pilot.canonical_tar(entries); target=self.root/"changed.tar";target.write_bytes(data)
        summary={**self.summary,"bundle_sha256":auto.pilot.digest(data)}; return target,summary

    def test_dynamic_source_bundle_round_trip_is_deterministic(self):
        manifest,files=auto.verify(self.bundle,self.summary); self.assertEqual(manifest["source_commit"],"a"*40)
        other=self.root/"other.tar"; self.assertEqual(auto.pack(self.site,"candidate","a"*40,other),self.summary)
        auto.materialize(files,self.root/"extract"); self.assertEqual(auto.pilot.site_files(self.root/"extract"),files)

    def test_outer_hash_and_inner_file_hash_are_both_required(self):
        with self.assertRaisesRegex(ValueError,"SHA-256"): auto.verify(self.bundle,{**self.summary,"bundle_sha256":"0"*64})
        target,summary=self.rewrite({"site/assets/index-test.js":b"tampered"})
        with self.assertRaisesRegex(ValueError,"hash/size"): auto.verify(target,summary)

    def test_traversal_extra_file_and_wrong_manifest_origin_rejected(self):
        for extra in [{"../escape":b"x"},{"site/extra.txt":b"x"}]:
            target,summary=self.rewrite(extra)
            with self.assertRaisesRegex(ValueError,"archive entry"): auto.verify(target,summary)
        target,summary=self.rewrite(change_manifest=lambda m:m.update(origin="https://example.com"))
        with self.assertRaisesRegex(ValueError,"origin"): auto.verify(target,summary)

    def test_source_kind_and_summary_claim_cannot_disagree(self):
        for field,value in [("source_commit","b"*40),("kind","rollback"),("files",{})]:
            with self.subTest(field=field),self.assertRaises(ValueError): auto.verify(self.bundle,{**self.summary,field:value})

    def test_symlink_and_duplicate_tar_entries_rejected(self):
        for duplicate in [False,True]:
            stream=io.BytesIO()
            with tarfile.open(fileobj=stream,mode="w") as archive:
                entry=tarfile.TarInfo("site/index.html")
                if duplicate:
                    entry.size=1;archive.addfile(entry,io.BytesIO(b"x"));archive.addfile(entry,io.BytesIO(b"x"))
                else: entry.type=tarfile.SYMTYPE;entry.linkname="/tmp/outside";archive.addfile(entry)
            target=self.root/"unsafe.tar";target.write_bytes(stream.getvalue())
            with self.assertRaises(ValueError): auto.verify(target,{**self.summary,"bundle_sha256":auto.pilot.digest(stream.getvalue())})

    def test_recovery_capture_preserves_actual_previous_source_not_event_before(self):
        selection={"kind":"artifact","source_commit":"a"*40}
        files=auto.pilot.site_files(self.site)
        with patch.object(auto.pilot,"public_bytes",side_effect=lambda p:files[p]):
            result=auto.capture(selection,self.bundle,self.summary,self.root/"old",self.root/"old.tar")
        self.assertEqual(result["source_commit"],"a"*40); self.assertEqual(result["kind"],"rollback")

    def test_unknown_live_or_changed_js_never_captured_or_overwritten(self):
        files=auto.pilot.site_files(self.site); selection={"kind":"artifact","source_commit":"a"*40}
        with patch.object(auto.pilot,"public_bytes",return_value=b"unexpected"),self.assertRaisesRegex(ValueError,"recorded known-good"):
            auto.capture(selection,self.bundle,self.summary,self.root/"old",self.root/"old.tar")
        self.assertFalse((self.root/"old").exists())
        old=self.root/"old.tar"; rollback=auto.pack(self.site,"rollback","b"*40,old)
        with patch.object(auto.pilot,"public_bytes",side_effect=lambda p:files[p] if p=="index.html" else b"unexpected"),self.assertRaisesRegex(ValueError,"unexpected JavaScript"):
            auto.known_live({"candidate":(self.bundle,self.summary),"rollback":(old,rollback)},["candidate","rollback"])


class PreviousRecordTests(unittest.TestCase):
    def run_fixture(self, expired=False):
        run={"id":123,"run_attempt":2,"repository":{"full_name":auto.pilot.REPOSITORY},"head_branch":"main","event":"push","path":auto.WORKFLOW,"head_sha":"a"*40,"status":"completed","conclusion":"success"}
        artifact={"name":"sales-auto-published-candidate-123-2","expired":expired,"size_in_bytes":1000}
        return run,artifact

    def test_only_successful_release_job_counts_and_attempt_name_is_exact(self):
        run,artifact=self.run_fixture(); setup={**run,"id":122}
        with patch.object(auto,"git",return_value=b"") as git,patch.object(auto,"api",side_effect=[{"workflow_runs":[setup,run],"total_count":2},{"jobs":[{"name":"release","conclusion":"skipped"}]},{"jobs":[{"name":"release","conclusion":"success"}]},{"artifacts":[artifact]}]):
            result=auto.select_previous(Path("synthetic"),"b"*40,"synthetic")
        self.assertEqual(result["artifact_name"],artifact["name"]);self.assertEqual(result["source_commit"],"a"*40)
        git.assert_called_once_with(Path("synthetic"),"merge-base","--is-ancestor","a"*40,"b"*40)

    def test_expired_or_wrong_attempt_artifact_fails_closed(self):
        for artifact in [self.run_fixture(True)[1],{**self.run_fixture()[1],"name":"sales-auto-published-candidate-123-1"}]:
            run,_=self.run_fixture()
            with patch.object(auto,"git",return_value=b""),patch.object(auto,"api",side_effect=[{"workflow_runs":[run]},{"jobs":[{"name":"release","conclusion":"success"}]},{"artifacts":[artifact]}]),self.assertRaisesRegex(ValueError,"missing/expired"):
                auto.select_previous(Path("synthetic"),"b"*40,"synthetic")

    def test_wrong_run_origin_and_nonancestor_are_rejected(self):
        run,_=self.run_fixture();run["head_branch"]="feature"
        with patch.object(auto,"api",return_value={"workflow_runs":[run]}),self.assertRaisesRegex(ValueError,"identity"):
            auto.select_previous(Path("synthetic"),"b"*40,"synthetic")
        run,_=self.run_fixture()
        with patch.object(auto,"git",side_effect=subprocess.CalledProcessError(1,"synthetic ancestry")),patch.object(auto,"api",side_effect=[{"workflow_runs":[run]},{"jobs":[{"name":"release","conclusion":"success"}]}]),self.assertRaises(subprocess.CalledProcessError):
            auto.select_previous(Path("synthetic"),"b"*40,"synthetic")

    def test_bootstrap_only_when_no_prior_published_record_exists(self):
        with patch.object(auto,"api",return_value={"workflow_runs":[],"total_count":0}): result=auto.select_previous(Path("synthetic"),"b"*40,"synthetic")
        self.assertEqual(result["files"],auto.BOOTSTRAP);self.assertEqual(result["source_commit"],auto.BOOTSTRAP_SOURCE)
        with patch.object(auto,"api",return_value={"workflow_runs":[],"total_count":101}),self.assertRaisesRegex(ValueError,"history exceeds"):
            auto.select_previous(Path("synthetic"),"b"*40,"synthetic")

    def test_git_child_does_not_inherit_ephemeral_github_tokens(self):
        with patch.dict(os.environ,{"GH_TOKEN":"synthetic-read-token","GITHUB_TOKEN":"synthetic-other","GH_ENTERPRISE_TOKEN":"synthetic-enterprise"}),patch.object(subprocess,"check_output",return_value=b"synthetic") as child:
            auto.git(Path("synthetic"),"status")
        env=child.call_args.kwargs["env"]
        self.assertFalse({"GH_TOKEN","GITHUB_TOKEN","GH_ENTERPRISE_TOKEN"} & set(env))


class WorkflowIntegrationTests(unittest.TestCase):
    """Execute the real future-artifact shell branch with actual immutable tar/JSON files."""
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.source=Path(__file__).resolve().parent.parent
        self.workflow=(self.source/auto.WORKFLOW).read_text()
        scripts=self.root/"candidate/scripts";scripts.mkdir(parents=True)
        for name in ["security-auto-release.py","security-pilot.py"]: shutil.copyfile(self.source/"scripts"/name,scripts/name)
        binpath=self.root/"test-bin";binpath.mkdir()
        # Test-only interpreter wrapper changes only HTTP reads into an explicit synthetic local fixture.
        wrapper=binpath/"python3"
        wrapper.write_text(f"#!{sys.executable}\n"+"\n".join([
            "import importlib.util,os,sys", "from pathlib import Path",
            "script=Path(sys.argv[1]).resolve();sys.argv=sys.argv[1:]",
            "spec=importlib.util.spec_from_file_location('fixture_auto',script)",
            "module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)",
            "module.pilot.public_bytes=lambda p:(Path(os.environ['SYNTHETIC_LIVE_SITE'])/p).read_bytes()",
            "module.main()", ""]))
        wrapper.chmod(0o755);self.binpath=binpath

    def tearDown(self):self.tmp.cleanup()
    def step(self,name):
        text=self.workflow.split("      - name: "+name+"\n",1)[1]
        return text.split("      - name:",1)[0]
    def capture_script(self):
        text=self.step("Capture only exact recorded live bytes into a new immutable recovery bundle")
        run=text.split("        run: |\n",1)[1]
        return "\n".join(line[10:] for line in run.splitlines() if line.startswith("          "))+"\n"
    def site(self,name):
        site=self.root/name;(site/"assets").mkdir(parents=True)
        (site/"index.html").write_text(f'<script type="module" src="/Sales_Haken_simu/assets/index-{name}.js"></script><div id="root"></div>')
        (site/"assets"/f"index-{name}.js").write_text("synthetic "+name)
        return site
    def record(self,site,source,folder):
        folder.mkdir(parents=True)
        summary=auto.pack(site,"candidate",source,folder/"site-bundle.tar")
        (folder/"summary.json").write_text(json.dumps(summary));return summary
    def run_capture(self,site,selection,record):
        shutil.copytree(record,self.root/"previous")
        (self.root/"previous-selection.json").write_text(json.dumps(selection))
        env={**os.environ,"PATH":str(self.binpath)+os.pathsep+os.environ["PATH"],"PREVIOUS_KIND":"artifact","SYNTHETIC_LIVE_SITE":str(site)}
        subprocess.check_output(["bash","--noprofile","--norc","-e","-o","pipefail","-c",self.capture_script()],cwd=self.root,env=env,stderr=subprocess.PIPE)
        summary=json.loads((self.root/"rollback/summary.json").read_text())
        return summary,auto.verify(self.root/"rollback/site-bundle.tar",summary)

    def test_second_release_artifact_branch_creates_staging_before_shell_redirection(self):
        site=self.site("previous-live");record=self.root/"downloaded-record";self.record(site,"a"*40,record)
        self.assertFalse((self.root/"rollback").exists())
        summary,(_,files)=self.run_capture(site,{"kind":"artifact","source_commit":"a"*40},record)
        self.assertEqual(summary["kind"],"rollback");self.assertEqual(summary["source_commit"],"a"*40)
        self.assertEqual(files,auto.pilot.site_files(site))

    def test_release_only_rerun_attempt_two_records_actual_prepare_attempt_one_bytes_for_next_release(self):
        site=self.site("published");prepared=self.root/"fixed";summary=self.record(site,"a"*40,prepared)
        # The successful release uses the exact prepared bytes; it does not rebuild or relabel its source.
        with patch.object(auto.pilot,"public_bytes",side_effect=lambda p:(site/p).read_bytes()):
            self.assertEqual(auto.known_live({"candidate":(prepared/"site-bundle.tar",summary)},["candidate"])["known_live"],"candidate")
        step=self.step("Retain immutable published candidate record for this successful release attempt")
        self.assertIn("if: steps.check.outcome == 'success'",step);self.assertIn("path: fixed",step)
        self.assertIn("name: sales-auto-published-candidate-${{ github.run_id }}-${{ github.run_attempt }}",step)
        published=self.root/"artifact-store/sales-auto-published-candidate-777-2";shutil.copytree(prepared,published)
        self.assertEqual((published/"site-bundle.tar").read_bytes(),(prepared/"site-bundle.tar").read_bytes())
        self.assertEqual((published/"summary.json").read_bytes(),(prepared/"summary.json").read_bytes())
        run={"id":777,"run_attempt":2,"repository":{"full_name":auto.pilot.REPOSITORY},"head_branch":"main","event":"push","path":auto.WORKFLOW,"head_sha":"a"*40,"status":"completed","conclusion":"success"}
        artifacts=[{"name":"sales-auto-bundle-candidate-777-1","expired":False,"size_in_bytes":1000},{"name":published.name,"expired":False,"size_in_bytes":1000}]
        with patch.object(auto,"git",return_value=b""),patch.object(auto,"api",side_effect=[{"workflow_runs":[run],"total_count":1},{"jobs":[{"name":"release","conclusion":"success"}]},{"artifacts":artifacts}]):
            selection=auto.select_previous(Path("synthetic"),"b"*40,"synthetic")
        self.assertEqual(selection["artifact_name"],published.name)
        self.assertEqual(selection["run_attempt"],"2")
        recovery,(_,files)=self.run_capture(site,selection,published)
        self.assertEqual(recovery["source_commit"],"a"*40)
        self.assertEqual(files,auto.pilot.site_files(site))

    def test_legacy_ci_routing_skips_only_new_automatic_pr_prefix(self):
        legacy=(self.source/".github/workflows/security-verify.yml").read_text()
        self.assertIn("if: github.event_name != 'pull_request' || !startsWith(github.head_ref, 'codex/security-auto-')",legacy)
        should_run=lambda event,head:event!='pull_request' or not head.startswith('codex/security-auto-')
        self.assertFalse(should_run('pull_request','codex/security-auto-synthetic'))
        self.assertTrue(should_run('pull_request','ordinary-feature'))
        self.assertTrue(should_run('push','codex/security-maintenance-phase2'))

    def test_failed_durable_record_recovers_old_and_keeps_release_failed(self):
        recovery=self.step("Upload exact old Pages recovery after any candidate failure")
        self.assertIn("steps.record.outcome == 'failure'",recovery)
        terminal=self.step("Preserve actual outcomes and never mark failed publication as successful")
        self.assertIn("RECORD: ${{ steps.record.outcome }}",terminal)
        self.assertIn("all(outcome[k]=='success' for k in ['PUBLISH','CHECK','RECORD'])",terminal)


if __name__ == "__main__": unittest.main(verbosity=2)
