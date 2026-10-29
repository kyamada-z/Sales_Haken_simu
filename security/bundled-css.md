# Sales bundled CSS bootstrap

The existing runtime Tailwind CDN failed in independent Chromium with both the
unchanged production build and the Vite patch candidate. Both builds emitted
identical application JavaScript. Tailwind 3.4.17 now runs only at build time via
Vite's inline PostCSS plugin, and Vite emits one local CSS asset alongside the
unchanged JavaScript bytes. Business source, credentials, AI calls and storage
behavior are unchanged.

## Immutable verifier and workflow rendering

Publish this helper tree as a separate immutable Git commit H. Do not insert H
into these helper files. Render both `security/bundled-workflows/*.yml.in` into
the corresponding `.github/workflows/*.yml`, replacing `@VERIFIER_SHA@` with the
actual external H. The final candidate has H's complete file tree except those
rendered workflow bytes. The verifier checks every tracked path, mode and blob;
only package.json and package-lock.json may vary in later normal updates.

The one initial main transition must be a single-parent child of initialMain and
have every reviewed package and non-package byte exactly matching H and rendered
workflows. PR CI can verify the same tree on another source commit; main's own
Pages workflow revalidates its actual SHA and current main before publishing.

H's historical files and workflows remain unchanged. Run original 61 policy
cases, original archive tests, original browser rejection fixtures and original
release tests from H, plus the new CSS/recovery tests. Do not describe original
runtime-CDN browser failures as passing. The new browser copies all calculation,
chart, synthetic storage and browser error assertions and replaces the CDN rule
with exact local CSS hashes and zero external requests. `--allow-legacy` delegates
only a one-JS legacy recovery layout to the unchanged hash-checked old browser.

Candidates require exactly index.html, one hashed JS and one hashed CSS asset.
Recovery supports exact old two-file artifacts and new three-file artifacts;
existing v1 records retain their original strict verifier. Archive directories,
links, traversal, unknown paths, duplicates, hash/size mismatch and source/kind
mismatch remain forbidden. Capture reads actual expected live bytes before
materializing an immutable rollback artifact. No source rebuild substitutes for
actual previous bytes.

Main push/run/attempt/current-main guards, same-major original validators,
previous successful release/artifact provenance, pre-publish known-live checks,
failed-publish/check/record recovery, and failed final status are preserved.

Local-only verification does not constitute production publication. Keep the
existing Vercel gate/protection and fixed hosting scopes. After native CI and
actual publication/readback, update the existing automation's baseline to the
successfully delivered main; never leave its old two-file freeze as active.

The workflow rechecks an individually hash-pinned integrity shell guard after
application build, before browser/pack work, and at release/recovery boundaries.
It checks the immutable helper HEAD, tracked diff, every raw tracked blob/mode,
and rejects untracked helper/bytecode files. Candidate raw tracked bytes must
still match its exact commit; only owned node_modules/ and dist/ generated files
may be untracked. PYTHONDONTWRITEBYTECODE=1 prevents trusted cache generation.
This detects unexpected working-tree changes; it does not claim complete process
isolation against malicious dependency code running in the same runner.
