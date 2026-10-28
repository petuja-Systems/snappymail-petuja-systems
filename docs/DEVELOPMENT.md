# Local development and build

petuja.email is based on the SnappyMail v2.38.2 development tree. Its official
baseline is tag `v2.38.2`, commit
`e345550c7fddfffdda9095deba64e98dc1c59815`.

## Repository layout

- `dev/` contains JavaScript and Less source consumed by Gulp.
- `tasks/`, `gulpfile.js`, `package.json`, and `yarn.lock` are build inputs.
- `snappymail/v/0.0.0/` is the development application tree.
- `build/` and `cli/release.php` contain package-generation tools.
- `docker-compose.yml`, `Makefile`, and `.docker/` provide optional Docker workflows.

Gulp generates ignored CSS and JavaScript under
`snappymail/v/0.0.0/static/`. Edit source files and regenerate those assets;
do not edit generated CSS or JavaScript directly.

## Prerequisites

The lockfile uses Yarn Classic format. Install dependencies with Yarn 1.x and
Node.js, then use the project Gulp tasks below. petuja.email 1.1.0 requires PHP
8.2.35 or newer; no upper version bound is imposed. Local runtime and packaging
need the applicable PHP extensions, including `mbstring`, `zip`, and `Phar`.
The application also uses extensions such as OpenSSL and IMAP; Contacts demo
support requires PDO SQLite. Python 3 is required by localization and release
validation. Docker is optional.

## Submodules and vendored dependencies

`.gitmodules` declares `vendors/openpgp-5` and `vendors/squire2`, but this tree
stores both as ordinary tracked trees, not Git links. Their committed `dist/`
files are the Gulp inputs. These commands are safe to run on a fresh checkout:

```bash
git submodule update --init --recursive
git submodule status --recursive
```

They are a no-op for the current tree. Do not replace the vendor outputs or
update them to an arbitrary revision.

## Build, lint, and tests

Install the pinned JavaScript dependencies and build the normal development
output:

```bash
corepack yarn install --frozen-lockfile
corepack yarn gulp
```

The default Gulp task runs JavaScript lint, cleans generated static files, and
builds/minifies JavaScript and CSS. Explicit tasks include `gulp build`,
`gulp lint`, and `gulp css`.

Gulp also runs the structural localization validator. It can be run directly:

```bash
python3 scripts/validate_localization.py
```

The validator checks catalog JSON, placeholders, direction metadata, trusted
HTML fragments, language names, and relative-time data without executing
catalog content. The repository's Python and Node regression suites can be run
with:

```bash
python3 -m unittest discover -s tests -p 'test_*.py'
node --test tests/*.test.mjs
```

### Rendered login regression tests

After installing dependencies and building the assets, install the supported
browser binaries and run:

```bash
corepack yarn playwright install chromium firefox webkit
corepack yarn gulp
corepack yarn test:login-layout
```

These tests load the real minified assets and templates with synthetic AppData
and intercepted authentication replies. Chromium, Firefox, and WebKit check
containment, overlap, focus reachability, error states, localization, and
increased text size. Firefox uses a touch-enabled desktop context because
Playwright does not support `isMobile` for that engine; it does not emulate an
iOS on-screen keyboard. Diagnostics use a temporary directory. Set
`PLAYWRIGHT_OUTPUT_DIR` to select another location outside the checkout.

The upstream Makefile's `rl-compile` target requires Docker. Some older
convenience targets refer to tasks not exported by this Gulp version; use the
exported tasks listed above.

## Safe local runtime

Do not copy production `data/`, `include.php`, mail, contacts, cookies, keys,
certificates, or IMAP/SMTP settings into the checkout. The root `_include.php`
is an example only. For a basic local UI runtime, create an ignored `include.php`
with a disposable data path:

```php
<?php

// Local-only development configuration. Never commit this file.
define('APP_DATA_FOLDER_PATH', __DIR__ . '/data/.dev/');
```

Start the PHP built-in server on loopback only:

```bash
php -S 127.0.0.1:8782 -t .
```

Open <http://127.0.0.1:8782/>. Mailbox access and sending require a deliberately
configured local mail service; never use production credentials for tests.

## Local visual demo

The demo runs the authenticated UI with a deterministic synthetic mailbox,
local SMTP capture, and native Contacts data. From the repository root:

```bash
node scripts/dev-demo.mjs
```

Alternatively, run `npm run dev:demo` or `corepack yarn dev:demo`. Open
<http://127.0.0.1:8782/> and sign in with:

```text
Email:    demo@example.test
Password: demo
```

The mailbox contains fictional messages and contacts. Sending uses an SMTP sink bound to loopback;
accepted messages stay in the demo workspace and are never delivered
externally. IMAP and SMTP use dynamic local ports.

The launcher builds local assets when needed and verifies startup services.
Runtime data and preferences stay outside the source tree in an isolated demo
workspace. The demo binds only to `127.0.0.1`, uses synthetic credentials, and
keeps plugins, two-factor enforcement, Contacts sync, and PHP mail disabled.
The workspace persists across restarts. To discard it, stop the demo and run:

```bash
node scripts/dev-demo.mjs --reset
```

`npm run dev:demo:reset` and `corepack yarn dev:demo:reset` run the same reset
command. Do not copy real mailbox or user data into the demo.

## Release-style package

On Unix-like environments with the upstream command-line prerequisites:

```bash
php release.php
```

The command runs Gulp, optionally creates precompressed static assets, and
produces a SnappyMail package under `build/dist/releases/webmail/2.38.2/`. The
development tree is restored when packaging finishes. On Windows, run Gulp
first and invoke packaging from Git Bash with `--skip-gulp` if the script cannot
launch Gulp through its Unix `which` lookup:

```bash
export PATH="$PWD/node_modules/.bin:$PATH"
php release.php --skip-gulp
```

The archive is ignored by Git. Do not sign with an unconfigured key or package
production data.

## Mail-server TLS trust

IMAP, SMTP, and Sieve verify the certificate chain and connected hostname when
TLS is used, including STARTTLS and saved domains. Legacy settings that disable
peer verification do not override these checks. For a private mail-server CA,
provision its public trust certificate in the PHP/system trust store or
configure `ssl.cafile` or a correctly hashed `ssl.capath` outside the release
tree. Fix expired certificates and hostname mismatches at the server; there is
no insecure retry. Explicit plaintext modes remain operator choices and are
not upgraded automatically.

## Keep local data out of source control

Keep `include.php`, `.env*`, credentials, private keys, certificates, mail,
contacts, cookies, and runtime data local. Do not commit `data/`, `node_modules/`,
generated CSS/JavaScript, release archives, logs, caches, or editor files.
Preserve the AGPL-3.0 license, RainLoop and SnappyMail notices, and all
third-party license and attribution files.
