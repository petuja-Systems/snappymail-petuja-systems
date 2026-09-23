# petuja.email product identity

This document defines the approved product-identity baseline for user-facing
petuja.email work. It intentionally establishes naming, branding constraints,
and attribution rules before the first broader UI customization.

## Naming

- User-facing product name: `petuja.email`
- Operator/organization: `petuja Systems`
- `petuja` is always written lowercase.
- Do not use `petuja.email Mail`, `petuja Mail`, `petuja.systems`, or another
  invented product-name variant in new user-facing work.
- Existing occurrences of `petuja.email Mail` in older repository documentation
  are legacy working wording and should be normalized when those files are next
  edited.
- `SnappyMail` remains the upstream project/engine name. Keep it in technical,
  licensing, copyright, and attribution contexts; do not perform a global
  search-and-replace of upstream identifiers or project references.

## Logo and favicon

- Initial product branding uses the official petuja Systems logo.
- No dedicated petuja.email logo has been approved yet. Do not invent one.
- For favicon/app-icon use an approved compact petuja Systems mark when an exact
  source asset is available; do not derive or redraw one without approval.
- Existing petuja logo/background CDN references are legacy/current deployment
  behavior, not a mandate to add further hotlinked assets.
- Once the exact approved files are available, prefer repository-managed/local
  assets for critical branding so the login/product identity does not depend on
  a second service at runtime.

## Colors

- Use the canonical petuja Systems color palette.
- Do not create a separate `petuja.email` or mail-specific palette unless that
  decision is explicitly made later.
- When implementation begins, centralize approved brand colors in reusable CSS
  variables/tokens instead of scattering literal color values through themes.
- Do not guess canonical hex values from screenshots or existing incidental CSS;
  use an approved source of truth.

## About, legal, and attribution

A user-facing About/Legal surface should clearly communicate, at minimum:

- product: `petuja.email`;
- operator: `petuja Systems`;
- that the application is based on SnappyMail;
- the SnappyMail engine version used by the running release (currently 2.38.2);
- that SnappyMail is licensed under GNU AGPL-3.0;
- access to the applicable license and required upstream attribution;
- a `Source Code` link to the corresponding published source for the running
  petuja.email release.

Preserve all existing SnappyMail, RainLoop, and third-party copyright/license
notices. petuja Systems may identify its own modifications and product branding,
but must not claim authorship of upstream code.

The exact prose/layout of the About surface is not fixed by this document and
may be designed with the UI later.

## Source-code link

`petuja-Systems/snappymail-petuja-systems` is the public fork intended for
published petuja.email source, but its default branch currently follows newer
upstream development rather than the private petuja.email product branch.
The public login derives its Source Code link from the running petuja.email
product version and targets the immutable release tag:

`https://github.com/petuja-Systems/snappymail-petuja-systems/tree/petuja-email-v<version>`

A production deployment must therefore verify that this exact public tag exists
and corresponds to the reviewed private source commit before switching the
running release. Never replace this with a generic link to the public
repository's default branch.

## Versioning

petuja.email has an independent product-version scheme. The initial product
version is `1.0.0`; the current SnappyMail engine version is `2.38.2`. These
version schemes are separate.

The machine-readable product metadata source is
`snappymail/v/0.0.0/app/petuja-product.json`. Future product releases must
update this metadata deliberately. `package.json` and `APP_VERSION` continue to
represent SnappyMail's own version and must not be repurposed as the
petuja.email product version.

The approved user-facing attribution format is:

```text
petuja.email <version> · based on SnappyMail <version>
```

## First branding implementation scope

The first product-identity implementation should be limited to:

- user-facing product name;
- approved logo and favicon assets;
- canonical petuja Systems color tokens;
- About/legal/attribution presentation;
- source/license metadata;
- technically accurate SnappyMail engine-version presentation where useful.

Do not combine this foundation step with a broad login redesign, mailbox UI
redesign, feature removal, authentication changes, or unrelated behavior changes.
Those should be separate reviewed changes after the identity foundation is in
place.
