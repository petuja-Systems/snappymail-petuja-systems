<div align="center">
  <img src="snappymail/v/0.0.0/static/images/petuja-systems-logo.svg" alt="petuja Systems" width="96">

  # petuja.email

  A petuja Systems webmail platform based on SnappyMail.

  **[petuja.email](https://petuja.email/)**
</div>

## About

**petuja.email** is the webmail product developed and operated by **petuja Systems**.
It is based on [SnappyMail](https://github.com/the-djmaze/snappymail) and keeps
the upstream project structure so changes remain reviewable and future upstream
work can be evaluated deliberately.

petuja.email has its own product versioning. The SnappyMail version identifies
the upstream engine baseline and is maintained separately.

## Current version

| Component | Version |
| --- | --- |
| petuja.email | **1.1.0** |
| SnappyMail baseline | **2.38.2** |
| Upstream baseline commit | `e345550c7fddfffdda9095deba64e98dc1c59815` |

This repository contains the finalized petuja.email **1.1.0** release source.
Corresponding-source publication and Production deployment are separate steps;
this table identifies the release source and does not identify the version
currently deployed in Production.

The machine-readable product metadata lives in
`snappymail/v/0.0.0/app/petuja-product.json`.

## petuja.email-specific work

The current petuja.email source builds on the fixed SnappyMail 2.38.2 baseline
with reviewed product-specific changes, including:

- petuja.email product identity and independent product-version metadata;
- a redesigned, responsive public login using local petuja Systems branding;
- local Rubik typography and associated font licensing;
- login legal navigation and product/upstream version attribution;
- native TOTP two-factor authentication with recovery codes and forced
  enrollment;
- native Light/Dark/System appearance with a quick appearance switch;
- selected localization, domain-definition, message-view, keyboard, and mobile
  improvements, plus a local synthetic demo environment.

This list describes petuja.email-specific work only. Features available in
upstream SnappyMail are not necessarily enabled in a particular deployment.

## Development

Install the pinned JavaScript dependencies and build the development assets:

```bash
corepack yarn install --frozen-lockfile
corepack yarn gulp
```

The existing PHP release tooling can produce a release-style SnappyMail package:

```bash
php release.php
```

On environments where the Gulp build has already been run, packaging can use:

```bash
php release.php --skip-gulp
```

Do not commit installation-specific or runtime data such as credentials,
private keys, certificates, mail, contacts, logs, caches, production
configuration, `include.php`, `.env*`, `data/`, `node_modules/`, or generated
release archives.

## Source and lineage

petuja.email is based on **SnappyMail 2.38.2**, which itself is derived from
**RainLoop Webmail Community Edition**.

- SnappyMail upstream: <https://github.com/the-djmaze/snappymail>
- petuja Systems public source repository:
  <https://github.com/petuja-Systems/snappymail-petuja-systems>

The public repository's default branch should not be assumed to match a running
petuja.email deployment. Corresponding source for a released petuja.email
version is identified by the release-specific public ref or tag associated with
that release.

## License

petuja.email modifications are distributed under the
[GNU Affero General Public License v3.0](LICENSE), preserving the applicable
upstream and third-party license and attribution notices.

petuja Systems identifies and maintains its own modifications and product
branding; upstream SnappyMail and RainLoop code remains attributed to its
respective authors.

Copyright (c) 2020–2024 SnappyMail  
Copyright (c) 2013–2022 RainLoop
