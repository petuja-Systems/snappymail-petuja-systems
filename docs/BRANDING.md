# petuja.email product identity

## Naming and attribution

- User-facing product name: `petuja.email`.
- Operator and organization: `petuja Systems`.
- Write `petuja` in lowercase. Do not introduce variants such as `petuja.email
  Mail`, `petuja Mail`, or `petuja.systems` as the product name.
- Keep `SnappyMail` and `RainLoop` in upstream, technical, licensing,
  copyright, and attribution contexts. Do not replace upstream identifiers.

The application is based on SnappyMail. User-facing attribution identifies the
petuja.email product version and the SnappyMail engine version independently.
Preserve all existing upstream and third-party notices; identify only
petuja.email modifications and branding as petuja Systems work.

## Logo and color

Use the approved petuja Systems identity assets already in the repository. No
separate petuja.email logo has been approved. Do not invent or redraw a logo.
Prefer repository-managed assets for essential product identity; do not add
new runtime hotlinks as a shortcut.

The authenticated Appearance quick switch currently uses scoped icon accents:
cyan `#11c6db` for a selected Light appearance and orange `#ff9933` for a
selected Dark appearance. In System mode the icon follows the effective Light
or Dark theme. These values describe that component's current behavior; they
are not global CSS tokens or a separately defined product palette. Keep the
selected control's non-color indication and neutral unselected icons intact.

## Source and versioning

petuja.email has an independent product-version scheme. The machine-readable
metadata is `snappymail/v/0.0.0/app/petuja-product.json`; `package.json` and
`APP_VERSION` continue to describe the SnappyMail engine and must not be
repurposed as the product version. The changelog identifies whether a product
version is released or remains in development.

A `Source Code` link for a running release must point to the corresponding
published source for that exact petuja.email version, not to the public fork's
moving default branch. Verify the release-specific source ref before using it.

Preserve the applicable AGPL-3.0 license and all required upstream and
third-party attribution material.
