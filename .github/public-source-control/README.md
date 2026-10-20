# Public corresponding-source controller

This one-release controller uses the public repository's Free-plan controls
and leaves `master` as the upstream-tracking branch. It preserves the private
publisher's `github.ref_protected` requirement by running from a separate
protected `petuja-email-release-control` branch.

## Installation and administrator prerequisites

Create `petuja-email-release-control` from the current public `master`. Install
`public-workflow.yml` as
`.github/workflows/publish-petuja-email-source.yml` on that branch. Install
this directory's `publish-public-source.sh` and `publication.json` at
`.github/public-source-control/`. Keep
`.github/public-source-control/publication-request.json` absent during setup.
The root `master` branch remains unchanged.

An authorized administrator must configure:

1. A public ruleset for `petuja-email-release-control` that requires reviewed
   changes and prevents force pushes and deletion. Do not allow administrator
   or workflow-actor bypass.
2. A `public-source` environment restricted to
   `petuja-email-release-control`, with an independent reviewer, no self-review,
   and no administrator bypass.
3. Environment secrets `PRIVATE_SOURCE_READ_KEY` and
   `PUBLIC_SOURCE_PUBLISH_KEY`. The first must be a unique read-only deploy key
   for the private source repository. The second must be a different unique
   write deploy key for the public repository. Do not reuse either key.
4. Public ref rules that let the public writer key create/update only the
   `petuja-email` product branch and create its version tag, while separate
   no-bypass rules prevent branch force-push/deletion and tag update/deletion.
   The release-control branch must stay outside the writer key's bypass.

Only after these settings are independently verified should a reviewed PR add
`publication-request.json` using the values in
`publication-request.example.json`. This is the explicit `PUBLISH` request;
its push triggers the workflow. The job also requires
`github.ref_protected`, and the environment reviewer approves before either
secret step runs. The connected repository API cannot inspect or configure
these settings and secrets.

## Security and publication behavior

The manifest pins the exact private release SHA, trusted private control SHA,
source tree and archive digest, expected public parent, product branch, control
branch, and immutable tag. The workflow branch filter, runtime branch check,
and public environment restriction must all name the manifest's exact
`petuja-email-release-control` branch. The request file must repeat the exact
SHA and version and say `PUBLISH`.
The workflow listens only for a push that changes this request file on the
protected release-control branch. The initial controller installation has no
request file and cannot publish.

Preparation has only the private read key. It fetches the fixed private
control commit, verifies that commit is reachable from private `main` and that
the release commit is its ancestor, then runs trusted validators/export tools
from that control checkout. Candidate files are read through `git archive` and
validated as data; candidate scripts and dependencies are never run. The
public branch must still equal the expected 1.0.1 parent and the 1.1.0 tag must
not exist. A bounded importer creates the public commit and annotated tag in a
bare repository and verifies the exact export tree and private-source
provenance. No source archive is uploaded as a public Actions artifact.

The public write key is referenced only by the final workflow step. That step
rechecks the remote parent and absent tag, performs one `git push --atomic`
without force, and independently verifies both remote refs afterward. If the
branch moved, the tag exists, validation differs, environment is missing, or a
repository rule rejects the operation, the controller fails closed. It never
falls back to the private publisher or a non-atomic push.

The reviewed request for this first run must use:

- private `RELEASE_SHA`: `6f9a5c82a1873bf3c9e2b301115220e8a21247b1`
- product version: `1.1.0`
- public branch parent: `78de51a284bca55e3d6f7b52a9f49f14778093e9`
- corresponding-source tree: `ae951e3b98a367b9b15111e3bbf5cc3677807389`
- raw source archive SHA-256: `236dfecfda9b681b33d51e1aeec96f41440370a7a1d5c7b41157250c1cf5b2e6`
- immutable tag: `petuja-email-v1.1.0`

The bundle is private release orchestration and is excluded from corresponding
source by the root `.gitattributes` rule for `.github/`.
