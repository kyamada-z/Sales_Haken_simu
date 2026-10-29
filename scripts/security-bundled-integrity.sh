#!/usr/bin/env bash
set -euo pipefail
test "$#" -eq 3
verifier_expected="$1"
candidate_repo="$2"
candidate_head="$3"
trusted_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
test "$(git -C "$trusted_root" rev-parse HEAD)" = "$verifier_expected"
git -C "$trusted_root" diff --no-ext-diff --no-textconv --exit-code HEAD --
test -z "$(git -C "$trusted_root" ls-files --others)"
(
  cd -- "$trusted_root"
  printf '%s\n' \
    'b12e14202c1d147a140b12d8487ec7663757929fd7791dd914376ef44244e14c  scripts/security-auto-release.py' \
    'fec605dcc49eb92caac8dda4f6d7900440cdf06a8a57e887917fca21ea692965  scripts/security-auto-release.test.py' \
    '56a2b2e7570fe351f13e5b33c90315060d46e1a8dbbdf9d93781cdf015d29e58  scripts/security-bundled-artifact.py' \
    '7b53111b005ae6aa27d36e18d43f61deb1f6966368c94357dd41ce85f8e797b8  scripts/security-bundled-browser.mjs' \
    '419691870107d3dc65b3bdcb357a9a2054918247e3c97ebcc2f67f59d8118311  scripts/security-bundled-policy.mjs' \
    'da80cb986295780b2fbc9ae4fb419409a232a3507aab9575d5eecd0e2da3f7e4  scripts/security-bundled-release.py' \
    'df552729b7f03ab3a20857f3bfd7399778f8d70da798a4b659f9305b25062a3b  scripts/security-bundled-release.test.py' \
    '82127328a2d259a794dbe3ef9f2960af43e0e4f08ad5edd9e2173a2976f288c6  scripts/security-pilot-browser.mjs' \
    'a557f7807ef92b04a2b5f8bd97950c870d0f52c70b4b3981dac0346bb0497a93  scripts/security-pilot-once.py' \
    '9e5f8b7b0bdc5417d91912ee8165bce79d7ab89eec9a97bb763abe3fa503af17  scripts/security-pilot-once.test.py' \
    '0399e69ed5525c0d3c5966cb9ba2db8e326d6d6d7f4f05c35091f9e6d5f6a5b8  scripts/security-pilot.py' \
    '9cef1ce02b7cdc1c36101452549ca3ce15f3eba9c132966981ecbd237d978868  scripts/security-pilot.test.py' \
    '2e27d8559c759fed7e5acc0b3f83052973c70e2ab65635ff6f8da1b096cec1cf  scripts/security-policy.mjs' \
    '2da993ebea815bf41f36c12c0d1e2a4644d1400e3f0dcefc5868c37195fcb40d  scripts/security-policy.test.mjs' | sha256sum --check --status
)
PYTHONDONTWRITEBYTECODE=1 python3 "$trusted_root/scripts/security-bundled-release.py" integrity --repo "$candidate_repo" --head "$candidate_head"
