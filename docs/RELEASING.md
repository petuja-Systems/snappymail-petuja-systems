# petuja.email release process

This document defines the release model for petuja.email. The private
`petuja-Systems/petuja.email` repository remains the development source of
truth. Production releases and the public corresponding-source snapshot must
always be derived from the same reviewed private commit.

## Version model

petuja.email has its own product version, stored in:

`snappymail/v/0.0.0/app/petuja-product.json`

The SnappyMail engine version remains independent and continues to come from the
upstream package/application version.

For the first product release:

- petuja.email: `1.0.0`
- SnappyMail: `2.38.2`
- fixed upstream baseline:
  `e345550c7fddfffdda9095deba64e98dc1c59815`

A release is not considered published merely because the product metadata was
updated. Before publishing corresponding source, finalize the release date in
the changelog and run the release-ready validation. The public source tag and
production deployment must then use that exact finalized private commit.

## Release invariant

For every production version, these must describe the same reviewed source:

```text
private release commit
        =
public corresponding-source tag
        =
production release artifact
```

Never publish a generic link to the public repository default branch as the
corresponding source for a running release.

## Public source layout

The public repository is:

`petuja-Systems/snappymail-petuja-systems`

Its `master` branch remains an upstream-tracking branch and is not the
petuja.email product branch.

petuja.email source releases use:

- branch: `petuja-email`
- immutable tag: `petuja-email-v<product-version>`

The first `petuja-email` branch is rooted at the official SnappyMail 2.38.2
baseline commit. Each later petuja.email source release advances that branch and
creates a new immutable tag.

The public snapshot contains the complete corresponding source needed to build
and understand petuja.email, including source, build inputs, licensing,
third-party attribution, and public development documentation. Internal agent
instructions and private CI/release orchestration are excluded with
`.gitattributes` `export-ignore`.

Runtime/customer data is never a source input and must never be published.

If a future local page such as `/datenschutz/` or `/impressum/` is implemented
as tracked petuja.email source, it is included in the public source by default.
Publicly rendered legal content does not need to be hidden from the
corresponding-source repository.

## Safe release candidate build

The manual GitHub Actions workflow
`.github/workflows/release-check.yml` performs a non-publishing release check.

It:

1. validates product/SnappyMail version metadata;
2. installs the frozen Yarn dependency set;
3. lints all tracked PHP source;
4. runs the normal SnappyMail release build;
5. verifies the checkout was not unexpectedly modified;
6. creates and validates the public-source export;
7. verifies the release archive contains petuja product metadata;
8. creates SHA-256 checksums and a release manifest;
9. uploads temporary private workflow artifacts.

This workflow does not modify the public repository and does not deploy
production.

## Publishing corresponding source

The manual workflow
`.github/workflows/publish-public-source.yml` exports and validates source from
a selected private commit/ref, then publishes it to the public
`petuja-email` branch and creates the immutable
`petuja-email-v<version>` tag.

Cross-repository authentication uses a repository-scoped SSH deploy key:

1. generate a dedicated Ed25519 key pair for public-source publication;
2. add the public key to
   `petuja-Systems/snappymail-petuja-systems` as a deploy key with write
   access;
3. store only the private key in the private `petuja.email` repository Actions
   secret named `PUBLIC_SOURCE_DEPLOY_KEY`;
4. do not reuse the key for production SSH access or any other repository.

The workflow intentionally performs an atomic push of the public branch and tag.
An existing release tag is treated as immutable and causes the workflow to
stop.

## Production deployment

Production deployment is deliberately separate from public-source publishing.
The server is not a Git checkout and never receives credentials for the private
repository.

The current CloudPanel installation uses:

- site user: `petujaemail`;
- existing document root: `/home/petujaemail/htdocs/petuja.email`;
- persistent SnappyMail data:
  `/home/petujaemail/htdocs/petuja.email/data`;
- installed SnappyMail data version: `2.38.2`.

The existing `data/` directory contains live customer/runtime state and is not
moved or replaced by application deployments. Once CloudPanel serves the
`/current` root directory, that data directory also sits outside the effective
web document root.

Versioned application releases live under:

```text
/home/petujaemail/petuja-email/
├── incoming/
└── releases/
    ├── legacy-snappymail-2.38.2-<timestamp>/
    └── petuja-email-<version>-<source-sha>/

/home/petujaemail/htdocs/petuja.email/
├── current -> /home/petujaemail/petuja-email/releases/<active-release>/
└── data/    # persistent production data; never replaced by a release
```

### One-time migration

Before the first automated deployment, run
`scripts/prepare-production-layout.sh` as the `petujaemail` site user with:

```bash
LIVE_ROOT=/home/petujaemail/htdocs/petuja.email \
RELEASE_BASE=/home/petujaemail/petuja-email \
CURRENT_LINK=/home/petujaemail/htdocs/petuja.email/current \
DATA_PATH=/home/petujaemail/htdocs/petuja.email/data \
./scripts/prepare-production-layout.sh
```

The script creates a legacy application snapshot without copying customer data,
generates a production-only `include.php` pointing to the existing persistent
data directory, and creates `current` pointing at that legacy snapshot. It does
not change live traffic.

After verifying the snapshot, change the CloudPanel site Root Directory from
the domain root to `/current`. The first switch therefore still serves the
legacy application and can be rolled back simply by restoring the previous Root
Directory.

### Deployment workflow

`.github/workflows/deploy-production.yml` deploys a reviewed release only after
the exact public tag `petuja-email-v<version>` exists and its public snapshot
commit records the same private source commit.

The workflow rebuilds the release from that private commit, verifies the
artifact, uploads it over a dedicated SSH key, installs it into a new immutable
release directory, writes the production-only `include.php`, atomically
switches the `current` symlink, and performs HTTP health checks. A failed health
check automatically restores the previous symlink target.

Required private-repository Actions secrets:

- `PRODUCTION_HOST`
- `PRODUCTION_SSH_PRIVATE_KEY`
- `PRODUCTION_KNOWN_HOSTS`

The production SSH key must be dedicated to this deployment path and must not be
reused for public-source publication. The server only receives the public half
through `~/.ssh/authorized_keys`.

The production workflow assumes SSH port 22. Change the workflow deliberately if
the server uses a different port.

## Release finalization and completion

Before publishing corresponding source for a production release:

- replace the matching changelog entry's `unreleased` marker with the intended
  release date;
- run `scripts/validate-release-ready.sh`;
- run a fresh release check from that exact finalized private commit.

After that commit passes validation, publish the exact corresponding-source tag
and deploy the exact same private commit. Do not modify release-facing source
between public-source publication and production deployment.

After both publication and deployment succeed:

- verify the product's Source Code link resolves to the exact immutable public
  release tag;
- keep the release tag immutable;
- use a new patch/minor/major product version for every later shipped source
  change.

Security fixes follow the same process. Do not silently replace the source behind
an existing version tag.
