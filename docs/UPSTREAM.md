# Upstream and release strategy

The imported production baseline is SnappyMail 2.38.2. The corresponding
official upstream tag is `v2.38.2` at commit
`e345550c7fddfffdda9095deba64e98dc1c59815`. The private `main` history is
based directly on that commit, preserving the complete official history up to
the release rather than using an unrelated deployment-snapshot root.

The upstream tag contains public demo/test crypto fixtures, including the
demo S/MIME files under `examples/crypto/`, the development-tree S/MIME pair,
and demo PGP fixtures. Those files remain exactly as published by upstream;
they are not petuja credentials. The production snapshot also contained a
versioned deployment copy of the S/MIME pair. That copy is not imported as a
production artifact; no separate production credential or runtime state is
kept in this repository.

The production snapshot was a deployed/release representation and contained
additional stale or bundled upstream files that are not part of the official
2.38.2 development tree. They are intentionally not replayed as petuja
changes. The clean baseline keeps the official source tree and reapplies only
the reviewed petuja.email customizations and repository safeguards.

## Remotes

```text
origin   git@github.com:petuja-Systems/petuja.email.git
public   https://github.com/petuja-Systems/snappymail-petuja-systems.git
upstream https://github.com/the-djmaze/snappymail.git
```

`origin` is the private development repository and `main` is its source of
truth. `public` and `upstream` are read/fetch-only references; neither may be
used as a push destination in routine development.

The public fork's default `master` branch currently follows upstream development
past the stable v2.38.2 release. It is therefore not the corresponding source
for the current private petuja.email product branch and must not be used as a
generic product `Source Code` target. When a petuja.email version is released,
publish the exact reviewed corresponding source to a dedicated public branch,
tag, and/or release and link the running product to that specific source ref.
Do not rewrite the public default branch merely to satisfy a product release.

## v2.38.2 vendor paths

The v2.38.2 `.gitmodules` file declares `vendors/openpgp-5` and
`vendors/squire2`, but the baseline tree stores both paths as ordinary tracked
trees rather than Git-link entries. Their committed `dist/` outputs are the
build inputs. `git submodule update --init --recursive` is consequently a
no-op for this repository state, and there are no submodule commit SHAs to
verify or update.

## Updating SnappyMail

1. Fetch the desired upstream tag or public-fork state into an isolated clone.
2. Compare the release/deployment representation with the upstream development
   tree and verify the build inputs before importing changes.
3. Check the complete history and tree for credentials, runtime state, and
   production-specific private material. Keep public upstream demo fixtures
   unchanged when they are part of the verified upstream baseline.
4. Reapply and review petuja.email source-level customizations; do not import
   generated release assets when the upstream build can reproduce them.
5. Run the available lint/build checks and review licensing and attribution.

Selected reviewed releases may later be published to
`petuja-Systems/snappymail-petuja-systems` for AGPL compliance. That is a
separate release operation and must never write to the official upstream
repository.
