# petuja.email

petuja.email is a webmail product from petuja Systems. This source targets
**petuja.email 1.1.1**, based on **SnappyMail 2.38.2**, which is derived from
RainLoop Webmail Community Edition. Product and engine versions are maintained
separately in `snappymail/v/0.0.0/app/petuja-product.json` and `package.json`.

## Build and package

Use PHP 8.2.35 or newer with the ZIP, Phar and mbstring extensions, Node.js with
Corepack and Yarn, Python 3, and the pinned dependencies in `yarn.lock`. `gzip`
and `brotli` are used when available to produce precompressed assets.

```sh
corepack yarn install --frozen-lockfile
corepack yarn gulp
PATH="$PWD/node_modules/.bin:$PATH" SOURCE_DATE_EPOCH=1793145600 php release.php
```

The ZIP and tar.gz packages are written under
`build/dist/releases/webmail/2.38.2/`. Set `SOURCE_DATE_EPOCH` to the same Unix
timestamp for reproducible ZIP and TAR timestamps; a Git checkout can omit it
and use the latest commit timestamp. The release command also runs the Gulp build, and
`php release.php --skip-gulp` packages an existing build using the same PATH
and timestamp settings. Gulp retains the normal development outputs and creates
the product-versioned static tree used by the application.

The included Squire editor sources correspond to upstream fork commit
`66d9fa9825017e44dc387dbb005d1e55d51a2da8`. To rebuild its bundled input,
run `npm ci` and then `node build.js` in `vendors/squire2/`.
The included OpenPGP.js fork sources correspond to commit
`b2f9e6ca3d07333e7e53fe416c096075ff137b03`. To reproduce the shipped browser
bundle with the pinned historical build inputs, run
`node vendors/openpgp-5/rebuild.cjs /tmp/openpgp-rebuilt.js` and compare that
file with `vendors/openpgp-5/dist/openpgp.js`. This needs npm registry access
and writes only to a temporary directory and the new output file.

Extract a package into the web server's application directory and provide a
writable, protected data directory. The supplied Apache configuration allows
the Service Worker to use the root scope; other web servers must likewise send
`Service-Worker-Allowed: /` for its script. The supplied container configuration
is in `.docker/release/`.
Its Dockerfile defaults to the ZIP epoch when Git history is unavailable;
pass `--build-arg SOURCE_DATE_EPOCH=<timestamp>` to select another timestamp.
Existing account storage may require the offline procedure described in
[Account storage and offline recovery](docs/account-storage.md).

## Source and license

The [public source repository](https://github.com/petuja-Systems/snappymail-petuja-systems)
contains release-specific corresponding-source refs. Its default branch does
not necessarily match a running deployment. The upstream project is
[SnappyMail](https://github.com/the-djmaze/snappymail).

petuja.email modifications are distributed under the
[GNU Affero General Public License v3.0](LICENSE), with applicable upstream and
third-party notices retained. SnappyMail and RainLoop remain attributed to their
respective authors.

Copyright (c) 2020–2024 SnappyMail  
Copyright (c) 2013–2022 RainLoop
