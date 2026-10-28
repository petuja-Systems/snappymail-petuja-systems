# Contributing to petuja.email

petuja.email is based on SnappyMail 2.38.2. Keep changes reviewable against
that upstream baseline and avoid combining unrelated work.

## Before starting

Read the public [README](README.md) for the build, product identity, and
upstream lineage.

Base changes on the intended petuja.email source revision and state the user
impact, scope, and relevant upstream behavior in the change description. For
substantial external changes, discuss the approach with the maintainers before
beginning a large implementation.

Do not report security vulnerabilities through a public issue or pull request.
Follow [SECURITY.md](SECURITY.md).

## Development setup

Install the pinned JavaScript dependencies:

```bash
corepack yarn install --frozen-lockfile
```

Build and lint the development output:

```bash
corepack yarn gulp
```

The repository keeps the SnappyMail source and build layout. Edit source files
rather than generated CSS or JavaScript. See the [README](README.md) for build
instructions. Never copy production
credentials, mail, contacts, private keys, certificates, logs, or runtime data
into a development checkout.

## Change guidelines

Keep changes focused and minimal.

- Preserve SnappyMail, RainLoop, and third-party copyright and license notices.
- Use the approved product name `petuja.email`; keep `petuja` lowercase.
- Do not globally replace upstream `SnappyMail` or `RainLoop` identifiers.
- Do not commit secrets, production configuration, user data, caches, logs, or
  generated release archives.
- Do not add analytics, telemetry, remote fonts, third-party scripts, or other
  runtime dependencies without review.
- Preserve authentication, session, cookie, mail-rendering, attachment,
  encryption, and integration behavior unless the change explicitly requires
  modifying it.
- Keep source changes compatible with the existing build and packaging tools.

Security-sensitive changes need focused security review and regression tests.
Other changes should include tests for important behavior and verify that
protected behavior remains unchanged.

## Validation

Run the checks relevant to the files you changed. For normal application work,
the baseline checks include:

```bash
corepack yarn gulp
git diff --check
```

PHP changes should also pass `php -l` for affected files. Packaging changes
should be checked with `php release.php` or, where the build has already run,
`php release.php --skip-gulp`.

Never use real production credentials or customer accounts for validation.

## License

Contributions are distributed under the
[GNU Affero General Public License v3.0](LICENSE), subject to existing
upstream and third-party license notices in the repository.
