# Contributing to petuja.email

petuja.email is a maintained customization of SnappyMail 2.38.2. Changes should
preserve upstream attribution, remain reviewable against the fixed SnappyMail
baseline, and avoid mixing unrelated refactors into product work.

## Before starting

Read:

- [Development](docs/DEVELOPMENT.md)
- [Upstream and release strategy](docs/UPSTREAM.md)
- [Product identity](docs/BRANDING.md)
- [Change workflow](docs/CHANGE_WORKFLOW.md)

The public petuja Systems source repository may contain release-specific source
branches as well as upstream-tracking branches. Verify that you are working from
the intended petuja.email source ref before preparing a change.

For substantial external changes, discuss the intended scope with the
maintainers before investing in a large implementation.

Security vulnerabilities must **not** be reported through a public issue or pull
request. Follow [SECURITY.md](SECURITY.md).

## Development setup

Install the pinned JavaScript dependencies:

```bash
corepack yarn install --frozen-lockfile
```

Build and lint the normal development output:

```bash
corepack yarn gulp
```

The repository uses the existing SnappyMail source/build layout. Edit source
files rather than generated CSS or JavaScript.

For a safe local runtime, follow
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). Never copy production credentials,
mail, contacts, private keys, certificates, logs, or runtime data into a
development checkout.

## Change guidelines

Keep changes focused and minimal.

- Preserve SnappyMail, RainLoop, and third-party copyright and license notices.
- Keep the approved product name exactly `petuja.email`; `petuja` is lowercase.
- Do not globally replace upstream `SnappyMail` or `RainLoop` identifiers.
- Do not commit secrets, production configuration, user data, caches, logs, or
  generated release archives.
- Do not add analytics, telemetry, remote fonts, third-party scripts, or other
  runtime dependencies without explicit review.
- Preserve authentication, session, cookie, mail-rendering, attachment,
  encryption, and plugin behavior unless the change explicitly requires
  modifying it.
- Keep source changes compatible with the existing build and release tooling
  unless a separately reviewed toolchain change is intended.

Application changes use the staged analysis, implementation, security-audit, and
regression-audit process documented in
[docs/CHANGE_WORKFLOW.md](docs/CHANGE_WORKFLOW.md).

## Validation

Run the checks relevant to the files you changed. For normal application work,
the baseline checks include:

```bash
corepack yarn gulp
git diff --check
```

PHP changes should also pass `php -l` for the affected files. Changes that
affect release packaging should be checked with the release workflow documented
in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

Never use real production credentials or customer accounts for validation.

## License

By contributing to this repository, you are contributing to software distributed
under the [GNU Affero General Public License v3.0](LICENSE), subject to the
existing upstream and third-party license notices in the repository.
