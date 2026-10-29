#!/usr/bin/env python3
"""Offline regression fixtures for immutable CSS bootstrap and exact recovery."""
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

spec = importlib.util.spec_from_file_location("bundled", Path(__file__).with_name("security-bundled-release.py"))
auto = importlib.util.module_from_spec(spec); spec.loader.exec_module(auto)
spec = importlib.util.spec_from_file_location("original_tests", Path(__file__).with_name("security-auto-release.test.py"))
legacy = importlib.util.module_from_spec(spec); spec.loader.exec_module(legacy)
# Reuse the unchanged original rejection cases against the new implementation.
legacy.auto = auto


def create_site(path, css=True):
    (path / "assets").mkdir(parents=True)
    html = '<script type="module" src="/Sales_Haken_simu/assets/index-test.js"></script><div id="root"></div>'
    if css: html += '<link rel="stylesheet" crossorigin href="/Sales_Haken_simu/assets/index-test.css">'
    (path / "index.html").write_text(html)
    (path / "assets/index-test.js").write_text("synthetic JS bytes")
    if css: (path / "assets/index-test.css").write_text("body{margin:0}")
    return path


class GitBoundaries(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.repo = Path(self.tmp.name) / "candidate"
        subprocess.check_output(["git", "clone", "--shared", "--no-checkout", str(auto.TRUSTED_ROOT), str(self.repo)], stderr=subprocess.PIPE)
        self.gitcmd("config", "user.name", "Synthetic Fixture"); self.gitcmd("config", "user.email", "fixture@example.invalid")
        self.gitcmd("checkout", "-B", "main", auto.INITIAL_MAIN)
        self.verifier = auto.git(auto.TRUSTED_ROOT, "rev-parse", "HEAD").decode().strip()
        self.gitcmd("read-tree", "--reset", "-u", self.verifier)
        for path, template in auto.WORKFLOW_TEMPLATES.items():
            self.write(path, (auto.TRUSTED_ROOT / template).read_text().replace("@VERIFIER_SHA@", self.verifier))
        self.activation = self.commit("synthetic exact CSS bootstrap")

    def tearDown(self): self.tmp.cleanup()
    def gitcmd(self, *args): return subprocess.check_output(["git", "-C", str(self.repo), *args], stderr=subprocess.PIPE).decode().strip()
    def write(self, path, value):
        target = self.repo / path; target.parent.mkdir(parents=True, exist_ok=True); target.write_text(value)
    def commit(self, message):
        self.gitcmd("add", "."); self.gitcmd("commit", "-m", message); return self.gitcmd("rev-parse", "HEAD")
    def dependency(self): self.write("package-lock.json", '{"lockfileVersion":3,"synthetic":1}\n'); return self.commit("synthetic package change")
    def event(self, before, head): return {"repository":{"full_name":auto.pilot.REPOSITORY},"ref":"refs/heads/main","before":before,"after":head,"head_commit":{"id":head},"forced":False,"created":False,"deleted":False}
    def env(self, head): return {"GITHUB_EVENT_NAME":"push","GITHUB_REPOSITORY":auto.pilot.REPOSITORY,"GITHUB_REF":"refs/heads/main","GITHUB_SHA":head,"GITHUB_WORKFLOW_SHA":head,"GITHUB_WORKFLOW_REF":auto.pilot.REPOSITORY+"/"+auto.WORKFLOW+"@refs/heads/main","GITHUB_RUN_ID":"123","GITHUB_RUN_ATTEMPT":"2","GH_TOKEN":"synthetic-test"}
    def guard(self, before, head, main=None):
        run={"repository":{"full_name":auto.pilot.REPOSITORY},"head_branch":"main","event":"push","path":auto.WORKFLOW,"head_sha":head,"run_attempt":2}
        with patch.object(auto,"api",side_effect=[run,{"object":{"sha":main or head}}]):
            return auto.event_guard(self.event(before,head),self.env(head),self.repo)

    def test_exact_bootstrap_is_one_reviewed_main_child(self):
        value=self.guard(auto.INITIAL_MAIN,self.activation)
        self.assertEqual(value["mode"],"bootstrap"); self.assertTrue(value["eligible"])

    def test_bootstrap_package_change_is_rejected(self):
        head=self.dependency()
        with self.assertRaisesRegex(ValueError,"Frozen"): auto.assess(self.repo,auto.INITIAL_MAIN,head)

    def test_bootstrap_extra_file_is_rejected(self):
        self.write("unapproved.txt","extra\n");head=self.commit("extra")
        with self.assertRaisesRegex(ValueError,"path addition"): auto.assess(self.repo,auto.INITIAL_MAIN,head)

    def test_legitimate_package_only_release_and_dynamic_source(self):
        head=self.dependency(); value=self.guard(self.activation,head)
        self.assertEqual(value["mode"],"release"); self.assertEqual(value["head"],head)
        self.assertEqual(value["trusted"],self.verifier)

    def test_no_change_is_not_release(self):
        with self.assertRaisesRegex(ValueError,"Only existing"): auto.assess(self.repo,self.activation,self.activation)

    def test_two_packages_only_are_eligible(self):
        self.write("package.json",'{"synthetic":1}\n');head=self.dependency()
        self.assertEqual(set(auto.assess(self.repo,self.activation,head)["paths"]),auto.DEPENDENCIES)

    def test_runtime_css_and_business_js_remain_frozen(self):
        for path in ["src/styles.css","src/App.jsx","vite.config.js","src/main.jsx"]:
            self.gitcmd("reset","--hard",self.activation);self.write(path,"unapproved\n");head=self.commit("drift")
            with self.subTest(path=path),self.assertRaisesRegex(ValueError,"Frozen"):auto.assess(self.repo,self.activation,head)

    def test_prior_workflow_or_helper_drift_is_rejected_on_later_package_push(self):
        for path in [auto.WORKFLOW,"scripts/security-bundled-release.py","security/bundled-workflows/pages-auto-release.yml.in"]:
            self.gitcmd("reset","--hard",self.activation);self.write(path,"unapproved\n");before=self.commit("prior drift");head=self.dependency()
            with self.subTest(path=path),self.assertRaisesRegex(ValueError,"Frozen"):auto.assess(self.repo,before,head)

    def test_lock_deletion_and_rename_are_rejected(self):
        for renamed in [False,True]:
            self.gitcmd("reset","--hard",self.activation)
            if renamed:self.gitcmd("mv","package-lock.json","elsewhere.json")
            else:self.gitcmd("rm","package-lock.json")
            head=self.commit("bad package path")
            with self.assertRaisesRegex(ValueError,"path addition"):auto.assess(self.repo,self.activation,head)

    def test_mode_or_symlink_drift_is_rejected(self):
        self.gitcmd("update-index","--chmod=+x","package.json");self.gitcmd("commit","-m","mode drift");head=self.gitcmd("rev-parse","HEAD")
        with self.assertRaisesRegex(ValueError,"mode"):auto.assess(self.repo,self.activation,head)
        self.gitcmd("reset","--hard",self.activation);(self.repo/"src/styles.css").unlink();(self.repo/"src/styles.css").symlink_to("/tmp/unrelated")
        head=self.commit("symlink")
        with self.assertRaisesRegex(ValueError,"regular"):auto.assess(self.repo,self.activation,head)

    def test_main_race_rejects_before_publication(self):
        head=self.dependency()
        with self.assertRaisesRegex(ValueError,"Main moved"):self.guard(self.activation,head,"b"*40)

    def test_multicommit_and_forced_push_are_rejected(self):
        first=self.dependency();self.write("package.json",'{"synthetic":2}\n');head=self.commit("second")
        with self.assertRaisesRegex(ValueError,"first-parent"):self.guard(self.activation,head)
        event=self.event(first,head);event["forced"]=True
        with self.assertRaisesRegex(ValueError,"Forced"):auto.event_guard(event,self.env(head),self.repo)

    def test_one_step_merge_with_package_only_diff_remains_valid(self):
        self.gitcmd("checkout","-b","feature");self.dependency();self.gitcmd("checkout","main");self.gitcmd("merge","--no-ff","feature","-m","synthetic merge")
        self.assertTrue(self.guard(self.activation,self.gitcmd("rev-parse","HEAD"))["eligible"])

    def test_postbuild_raw_source_tamper_rejected_even_if_index_assumes_unchanged(self):
        self.gitcmd("update-index","--assume-unchanged","src/App.jsx")
        self.write("src/App.jsx","unexpected build write\n")
        with self.assertRaisesRegex(ValueError,"Working file bytes changed"):auto.integrity(self.repo,self.activation)

    def test_postbuild_untracked_helpers_and_bytecode_are_rejected(self):
        for path in ["scripts/hashlib.py","scripts/__pycache__/hashlib.pyc","dist-extra/extra.js"]:
            self.write(path,"unexpected\n")
            with self.subTest(path=path),self.assertRaisesRegex(ValueError,"untracked"):auto.integrity(self.repo,self.activation)
            (self.repo/path).unlink()

    def test_only_owned_build_and_install_outputs_may_be_untracked(self):
        self.write("dist/index.html","synthetic compiled output\n");self.write("node_modules/synthetic/index.js","synthetic dependency output\n")
        self.assertTrue(auto.integrity(self.repo,self.activation)["integrity"])

    def test_postbuild_mode_change_and_head_move_are_rejected(self):
        (self.repo/"src/App.jsx").chmod(0o755)
        with self.assertRaisesRegex(ValueError,"Working file mode"):auto.integrity(self.repo,self.activation)
        (self.repo/"src/App.jsx").chmod(0o644);self.dependency()
        with self.assertRaisesRegex(ValueError,"HEAD changed"):auto.integrity(self.repo,self.activation)

    def test_hash_pinned_shell_guard_checks_actual_working_files(self):
        guard=auto.TRUSTED_ROOT/"scripts/security-bundled-integrity.sh"
        args=["bash","--noprofile","--norc",str(guard),self.verifier,str(self.repo),self.activation]
        result=subprocess.check_output(args,stderr=subprocess.PIPE,text=True)
        self.assertTrue(json.loads(result)["integrity"])
        self.gitcmd("update-index","--assume-unchanged","src/App.jsx");self.write("src/App.jsx","unexpected build write\n")
        with self.assertRaises(subprocess.CalledProcessError):subprocess.check_output(args,stderr=subprocess.PIPE,text=True)

    def test_pr_integrity_uses_exact_checkout_head_instead_of_merge_sha(self):
        (self.repo.parent/"trusted").symlink_to(auto.TRUSTED_ROOT,target_is_directory=True)
        template=auto.TRUSTED_ROOT/auto.WORKFLOW_TEMPLATES[".github/workflows/security-auto-verify.yml"]
        text=template.read_text().split("      - name: Verify immutable helper checkout before executing code\n",1)[1].split("      - name:",1)[0]
        run=text.split("        run: |\n",1)[1]
        script="\n".join(line[10:] for line in run.splitlines() if line.startswith("          "))+"\n"
        self.assertIn("${{ github.event.pull_request.head.sha || github.sha }}",script)
        script=script.replace("@VERIFIER_SHA@",self.verifier).replace("${{ github.event.pull_request.head.sha || github.sha }}",self.activation)
        env={**os.environ,"GITHUB_SHA":"f"*40,"PYTHONDONTWRITEBYTECODE":"1"}
        result=subprocess.check_output(["bash","--noprofile","--norc","-e","-o","pipefail","-c",script],cwd=self.repo.parent,env=env,stderr=subprocess.PIPE,text=True)
        self.assertTrue(json.loads(result)["integrity"])

    def test_shell_guard_strips_read_tokens_before_any_git_child(self):
        folder=self.repo.parent/"token-check-bin";folder.mkdir();wrapper=folder/"git";log=self.repo.parent/"git-child-token-checks.jsonl"
        real_git=shutil.which("git")
        wrapper.write_text(f"#!{sys.executable}\n"+"\n".join([
            "import json,os,sys", "keys=['GH_TOKEN','GITHUB_TOKEN','GH_ENTERPRISE_TOKEN']",
            "present=[key for key in keys if key in os.environ]",
            "with open(os.environ['SYNTHETIC_GIT_TOKEN_LOG'],'a') as f:f.write(json.dumps(present)+'\\n')",
            "if present:sys.exit(92)", f"os.execv({real_git!r},[{real_git!r}]+sys.argv[1:])", ""]))
        wrapper.chmod(0o755)
        env={**os.environ,"PATH":str(folder)+os.pathsep+os.environ["PATH"],"SYNTHETIC_GIT_TOKEN_LOG":str(log),"PYTHONDONTWRITEBYTECODE":"1"}
        tokens={key:"synthetic-read-only-token" for key in ["GH_TOKEN","GITHUB_TOKEN","GH_ENTERPRISE_TOKEN"]};env.update(tokens)
        args=["bash","--noprofile","--norc",str(auto.TRUSTED_ROOT/"scripts/security-bundled-integrity.sh"),self.verifier,str(self.repo),self.activation]
        result=subprocess.check_output(args,env=env,text=True,stderr=subprocess.PIPE)
        self.assertTrue(json.loads(result)["integrity"])
        values=[json.loads(line) for line in log.read_text().splitlines()]
        self.assertGreaterEqual(len(values),4);self.assertTrue(all(value==[] for value in values))
        self.assertTrue(all(env[key]==value for key,value in tokens.items()))

    def test_wrong_workflow_and_run_attempt_are_rejected(self):
        head=self.dependency();env=self.env(head);env["GITHUB_WORKFLOW_SHA"]="b"*40
        with self.assertRaisesRegex(ValueError,"Workflow identity"):auto.event_guard(self.event(self.activation,head),env,self.repo)
        run={"repository":{"full_name":auto.pilot.REPOSITORY},"head_branch":"main","event":"push","path":auto.WORKFLOW,"head_sha":head,"run_attempt":1}
        with patch.object(auto,"api",return_value=run),self.assertRaisesRegex(ValueError,"attempt"):auto.event_guard(self.event(self.activation,head),self.env(head),self.repo)


class BundleBoundaries(legacy.BundleBoundaries):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.site=create_site(self.root/"site")
        self.bundle=self.root/"bundle.tar";self.summary=auto.pack(self.site,"candidate","a"*40,self.bundle)

    def test_css_tamper_or_absence_never_verifies(self):
        target,summary=self.rewrite({"site/assets/index-test.css":b"tampered"})
        with self.assertRaisesRegex(ValueError,"hash/size"):auto.verify(target,summary)
        (self.site/"assets/index-test.css").unlink()
        with self.assertRaises(ValueError):auto.pack(self.site,"candidate","a"*40,self.root/"missing.tar")

    def test_wrong_css_reference_and_extra_css_are_rejected(self):
        html=(self.site/"index.html").read_text();(self.site/"index.html").write_text(html.replace("index-test.css","index-elsewhere.css"))
        with self.assertRaisesRegex(ValueError,"stylesheet"):auto.pilot.site_files(self.site)
        (self.site/"index.html").write_text(html);(self.site/"assets/index-extra.css").write_text("x")
        with self.assertRaises(ValueError):auto.pilot.site_files(self.site)

    def test_new_candidates_cannot_use_legacy_two_file_layout(self):
        old=create_site(self.root/"legacy",False)
        with self.assertRaisesRegex(ValueError,"bundled CSS"):auto.pack(old,"candidate","a"*40,self.root/"bad.tar")
        summary=auto.pack(old,"rollback","b"*40,self.root/"old.tar")
        _,files=auto.verify(self.root/"old.tar",summary);self.assertEqual(len(files),2)

    def test_legacy_v1_previous_record_still_has_original_strict_validation(self):
        old=create_site(self.root/"legacy-v1",False)
        spec=importlib.util.spec_from_file_location("legacy_release",Path(__file__).with_name("security-auto-release.py"))
        original=importlib.util.module_from_spec(spec);spec.loader.exec_module(original)
        summary=original.pack(old,"candidate","b"*40,self.root/"v1.tar")
        _,files=auto.verify(self.root/"v1.tar",summary);self.assertEqual(len(files),2)
        (self.root/"v1.tar").write_bytes(b"tampered")
        with self.assertRaises(ValueError):auto.verify(self.root/"v1.tar",summary)

    def test_directory_hardlink_and_absolute_archive_entries_are_rejected(self):
        for name,kind in [("site/assets/",tarfile.DIRTYPE),("site/assets/index-test.css",tarfile.LNKTYPE),("/site/index.html",tarfile.REGTYPE)]:
            stream=io.BytesIO()
            with tarfile.open(fileobj=stream,mode="w") as archive:
                entry=tarfile.TarInfo(name);entry.type=kind;entry.linkname="site/index.html";archive.addfile(entry)
            target=self.root/"unsafe.tar";target.write_bytes(stream.getvalue())
            with self.assertRaises(ValueError):auto.verify(target,{**self.summary,"bundle_sha256":auto.pilot.digest(stream.getvalue())})


class PreviousRecordTests(legacy.PreviousRecordTests):
    pass


class WorkflowIntegrationTests(legacy.WorkflowIntegrationTests):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.source=auto.TRUSTED_ROOT
        verifier=auto.git(self.source,"rev-parse","HEAD").decode().strip()
        self.workflow=(self.source/auto.WORKFLOW_TEMPLATES[auto.WORKFLOW]).read_text().replace("@VERIFIER_SHA@",verifier)
        scripts=self.root/"trusted/scripts";scripts.mkdir(parents=True)
        for name in ["security-auto-release.py","security-pilot.py","security-bundled-release.py","security-bundled-artifact.py"]:
            shutil.copyfile(self.source/"scripts"/name,scripts/name)
        binpath=self.root/"test-bin";binpath.mkdir();wrapper=binpath/"python3"
        wrapper.write_text(f"#!{sys.executable}\n"+"\n".join([
            "import importlib.util,os,sys", "from pathlib import Path", "script=Path(sys.argv[1]).resolve();sys.argv=sys.argv[1:]",
            "spec=importlib.util.spec_from_file_location('fixture_auto',script)", "module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)",
            "module.pilot.public_bytes=lambda p:(Path(os.environ['SYNTHETIC_LIVE_SITE'])/p).read_bytes()", "module.main()", ""]))
        wrapper.chmod(0o755);self.binpath=binpath

    def site(self,name):return create_site(self.root/name)

    def test_all_release_commands_use_immutable_verifier_not_candidate_code(self):
        self.assertNotIn("python3 candidate/scripts/",self.workflow)
        self.assertNotIn("node candidate/scripts/",self.workflow)
        self.assertIn("node trusted/scripts/security-bundled-browser.mjs --site candidate-site",self.workflow)
        self.assertIn("--allow-legacy --site old-site",self.workflow)
        self.assertIn("guard --repo candidate --event",self.workflow)
        self.assertIn("steps.record.outcome == 'failure'",self.workflow)

    def test_branch_browser_step_executes_desktop_and_mobile_separately(self):
        template=self.source/auto.WORKFLOW_TEMPLATES[".github/workflows/security-auto-verify.yml"]
        text=template.read_text().split("      - name: Verify calculations, three plots and synthetic report storage in real Chromium\n",1)[1]
        text=text.split("      - name:",1)[0]
        run=text.split("        run: |\n",1)[1]
        script="\n".join(line[10:] for line in run.splitlines() if line.startswith("          "))+"\n"
        self.assertLess(script.index("security-bundled-integrity.sh '@VERIFIER_SHA@'"),script.index("node trusted/"))
        # Integrity executes in a separate real-shell test. Here run the exact
        # two browser command lines to catch YAML folding/one-invocation errors.
        script="\n".join(line for line in script.splitlines() if line.startswith("node "))+"\n"
        node=self.binpath/"node"
        node.write_text(f"#!{sys.executable}\nimport json,os,sys\nwith open(os.environ['SYNTHETIC_NODE_CALLS'],'a') as f:f.write(json.dumps(sys.argv[1:])+'\\n')\n")
        node.chmod(0o755);calls=self.root/"node-calls.jsonl"
        env={**os.environ,"PATH":str(self.binpath)+os.pathsep+os.environ["PATH"],"SYNTHETIC_NODE_CALLS":str(calls)}
        subprocess.check_output(["bash","--noprofile","--norc","-e","-o","pipefail","-c",script],cwd=self.root,env=env,stderr=subprocess.PIPE)
        values=[json.loads(line) for line in calls.read_text().splitlines()]
        self.assertEqual(len(values),2);self.assertNotIn("--mobile",values[0]);self.assertIn("--mobile",values[1])
        self.assertIn("evidence/desktop",values[0]);self.assertIn("evidence/mobile",values[1])

    def test_every_integrity_boundary_command_has_valid_shell_syntax(self):
        commands=[]
        for path in auto.WORKFLOW_TEMPLATES.values():
            for line in (self.source/path).read_text().splitlines():
                if "bash --noprofile --norc trusted/scripts/security-bundled-integrity.sh" in line:
                    command=line.strip().replace("@VERIFIER_SHA@","a"*40).replace("${{ github.event.pull_request.head.sha || github.sha }}","b"*40)
                    subprocess.check_output(["bash","--noprofile","--norc","-n","-c",command],stderr=subprocess.PIPE)
                    commands.append(command)
        self.assertEqual(len(commands),13)


if __name__ == "__main__":unittest.main(verbosity=2)
