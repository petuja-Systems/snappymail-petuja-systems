# Upstream relationship

petuja.email is based on the official SnappyMail v2.38.2 development tree. The
baseline is tag `v2.38.2` at commit
`e345550c7fddfffdda9095deba64e98dc1c59815`. The tree preserves the official
history through that release and carries reviewed petuja.email customizations.

## Keeping the source aligned

When evaluating an upstream update:

1. Start from the intended official SnappyMail release or revision.
2. Compare its source and build inputs with the current baseline before
   importing changes.
3. Preserve upstream and third-party license and attribution material.
4. Reapply and review petuja.email source customizations; prefer reproducible
   source and build inputs over generated release output.
5. Run relevant lint, build, and regression checks.

The v2.38.2 tree declares `vendors/openpgp-5` and `vendors/squire2` in
`.gitmodules`, but stores them as ordinary tracked trees rather than Git links.
Their committed `dist/` files are the build inputs; there are no submodule
commits to update for this baseline.

## Historical shared S/MIME signing material

A shared S/MIME signing key was present in previously distributed source or
artifacts and must be treated as disclosed. Operators that used the affected
material should remove old deployed copies, retire trust in the shared signer,
and replace or reissue affected certificates under their own trust policy.
Removing material from the current source does not revoke certificates or
rotate deployed copies. The current source does not include a shared signer
private key. Keep replacement issuer keys outside the application source and
web-served paths.

## License and attribution

SnappyMail and RainLoop code retain their upstream authorship and notices.
Preserve all third-party license and attribution files when updating or
redistributing the source.