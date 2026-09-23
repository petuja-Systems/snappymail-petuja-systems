# Local development and build

petuja.email is built from the SnappyMail v2.38.2 development tree. The
official baseline is tag `v2.38.2`, commit
`e345550c7fddfffdda9095deba64e98dc1c59815`; private `main` applies only the
reviewed petuja.email customizations and repository-maintenance files.

## Repository layout

- `dev/` contains the JavaScript and Less source consumed by Gulp.
- `tasks/`, `gulpfile.js`, `package.json`, and `yarn.lock` are the upstream
  Node/Gulp build inputs.
- `snappymail/v/0.0.0/` is the development application tree. The release
  script temporarily renames it to `snappymail/v/<version>/` while packaging.
- `build/` and `cli/release.php` contain the upstream release/package scripts.
- `docker-compose.yml`, `Makefile`, and `.docker/` describe the optional
  Docker-based development and release environment.

Gulp generates these ignored development assets:

```text
snappymail/v/0.0.0/static/css/{boot,app,admin}.css
snappymail/v/0.0.0/static/css/{boot,app,admin}.min.css
snappymail/v/0.0.0/static/js/*.js
snappymail/v/0.0.0/static/js/min/*.js
snappymail/v/0.0.0/static/css/fonts/snappymail.*
```

Edit `dev/` or the relevant application source, then regenerate these files;
do not edit generated CSS or JavaScript directly.

## Prerequisites

The v2.38.2 package has no `engines` field. Its lockfile is Yarn Classic
format, so use Yarn 1.x (the verified run used Yarn 1.22.22). Node.js is
required for Gulp; the verified machine used Node.js 24.18.0 and npm 11.6.0.
PHP 7.4+ is the application minimum stated by SnappyMail, and PHP with
`mbstring`, `zip`, `Phar`, and the normal web extensions is needed for local
runtime and release packaging. The verified machine used PHP 8.2.12 with
`mbstring`, `zip`, `Phar`, and the other required extensions available.

Composer is not used by this v2.38.2 build. Docker is optional: the Makefile
delegates to `docker compose`, and the repository's Docker files build the
release-style image. Docker was not installed on the verified machine.

The upstream release script also looks for `gulp`, `gzip`, and `brotli` on
`PATH`. Gulp can be run project-locally through Yarn. Gzip and Brotli are
optional in the script; missing compressors omit the corresponding static
precompressed files. Git Bash supplies `which` and `gzip` on Windows, but
Brotli was not installed in the verified environment.

## Submodules and vendored dependencies

`.gitmodules` declares `vendors/openpgp-5` and `vendors/squire2`, but the
v2.38.2 commit records both paths as ordinary tracked trees (mode `040000`),
not Git links (mode `160000`). Their committed `dist/` files are therefore the
inputs used by Gulp. There are no recorded submodule commits to check out, and
`git submodule status --recursive` is empty for this commit.

For a fresh checkout, run the upstream-safe check anyway:

```bash
git submodule update --init --recursive
git submodule status --recursive
```

It is a no-op for the current tree. Do not replace the tracked vendor outputs
or update them to an arbitrary newer revision.

## Install dependencies and build development output

From the repository root:

```bash
corepack yarn install --frozen-lockfile
corepack yarn gulp --version
corepack yarn gulp
```

`corepack yarn gulp` is the upstream default task. It runs JavaScript lint,
cleans the development static directories, builds/minifies JavaScript and CSS,
copies the OpenPGP/vendor inputs, and copies the Fontastic fonts. Explicit
equivalents are `corepack yarn gulp build`, `corepack yarn gulp lint`, and
`corepack yarn gulp css`.

The upstream Makefile's `rl-compile` target invokes `docker compose ... gulp
build` and is usable only with Docker. Some older convenience targets refer to
tasks not exported by this exact `gulpfile.js` (`watch-js`, `watchCss`, and
`all`); use the exported Gulp tasks above for v2.38.2.

## Safe local runtime

Do not copy production `data/`, `include.php`, mail, contacts, cookies, keys,
certificates, or IMAP/SMTP settings into the checkout. The root
`_include.php` is an example only. Create an ignored root `include.php` with a
disposable data path, for example:

```php
<?php

// Local-only development configuration. Never commit this file.
define('APP_DATA_FOLDER_PATH', __DIR__ . '/data/.dev/');
```

The repository ignores both `include.php` and `data/`; the first unauthenticated
request creates the application data and default configuration under
`data/.dev/`. Start the PHP built-in server on localhost only:

```bash
php -S 127.0.0.1:8782 -t .
```

Open <http://127.0.0.1:8782/>. This is sufficient to verify the login/UI
without an IMAP or SMTP account. Authentication, mailbox access, sending, and
receiving require a deliberately configured local mail service; never use
production credentials for those tests.

For template/CSS debugging, the generated application configuration is under
`data/.dev/_data_/_default_/configs/application.ini`. The upstream debug
settings are `use_app_debug_js`, `use_app_debug_css`, and cache setting
`system_data`.

## Release-style package

On Unix-like environments with the upstream command-line prerequisites:

```bash
php release.php
```

This runs the default Gulp build, optionally creates `.gz`/`.br` static assets,
renames `snappymail/v/0.0.0` to `snappymail/v/2.38.2`, and creates:

```text
build/dist/releases/webmail/2.38.2/snappymail-2.38.2.zip
build/dist/releases/webmail/2.38.2/snappymail-2.38.2.tar.gz
```

The development tree is restored to `snappymail/v/0.0.0` when the command
finishes. On Windows, run the Gulp build first and invoke the packaging phase
from Git Bash with `--skip-gulp`; the release script's Unix `which` lookup can
return a path that Windows PHP cannot execute directly:

```bash
export PATH="$PWD/node_modules/.bin:$PATH"
php release.php --skip-gulp
```

The archive is ignored by Git. Do not use `--sign` without an explicitly
configured development signing key, and do not build or publish a release from
production data.

## Verifying petuja.email customizations

The current customizations are source files under
`snappymail/v/0.0.0/`, including:

- Gmail and Hotmail domain definitions;
- Esperanto (`eo`) user localization;
- `static/logo-text.png`;
- login and message-view template additions;
- Default and NextcloudV25+ theme CSS changes, including the existing petuja
  CDN/logo/background references.

The build makes the generated `static/css` and `static/js` files available.
The release script packages the source templates, themes, domain files,
localization, logo, and generated assets under the versioned directory. The
verified 2.38.2 ZIP contained all of those files and the expected petuja CDN
and theme changes.

The CDN images are intentionally not downloaded or replaced by the build. A
local smoke test without network access can therefore show a broken external
petuja logo and the default background even though the source references are
present. This is an existing external-asset dependency and a reproducibility
gap, not a reason to invent replacement assets.

## Files that stay local

The following must remain ignored or local:

- `include.php`, `.env*`, credentials, secrets, private keys, certificates,
  mail, contacts, cookies, and user/runtime data;
- `data/` and `data/.dev/`;
- `node_modules/`;
- generated `snappymail/v/0.0.0/static/css/` and `static/js/` output;
- `build/dist/`, temporary release archives, logs, caches, and editor files.

Keep the AGPL-3.0 license, RainLoop/SnappyMail copyright notices, and all
third-party attribution files intact. `origin` is the private development
repository. The `public` and `upstream` remotes are read/fetch-only and must
not receive pushes unless that separate operation is explicitly authorized.

## Verified commands and common failures

On 2026-09-04, the following passed in this checkout:

```text
corepack yarn install --frozen-lockfile
corepack yarn gulp
php -l on all 1,103 PHP files: 0 failures
php release.php --skip-gulp
localhost login page and static asset smoke test
```

The normal Windows `php release.php` path was not used because the script's
Unix `which gulp` result is not executable by Windows PHP. Docker-based targets
were not run because Docker is unavailable. The local browser reported no
console errors; no real login was attempted.
