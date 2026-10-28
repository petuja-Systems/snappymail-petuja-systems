# Account storage and offline recovery

petuja.email keeps account-storage ownership in a private registry. Existing
legacy storage cannot be assigned from directory names, credentials or a
successful login: an unassigned legacy tree blocks access until the operator
supplies an independently verified ownership map. An ordinary restore that
changes file identity may require re-attestation. No data is moved by the
adoption tool.

Use the `cli/account-storage.php` from the corresponding source with PHP 8.2.35
or newer. First back up the private data and metadata, and stop all web/PHP
workers, old-version workers, scheduled garbage collection and GPG processes.
The `--offline` flag asserts this quiescence; the tool does not establish it.
Do not run mixed versions against the storage afterward.

Create a complete one-to-one ownership map using authoritative records, never
inference. Place the JSON file outside the web root with mode 0600 on POSIX,
or a private Windows ACL. The following is a synthetic shape:

```json
{
  "authoritative_ownership": true,
  "accounts": [{
    "identity": "canonical@example.test",
    "source": "example.test/canonical",
    "children": [{
      "identity": "additional@example.test",
      "source": "additional@example.test"
    }]
  }]
}
```

Each identity is the exact effective canonical email address. Each main
`source` is the explicit relative two-component legacy root and each child
`source` is one component under that root. Account for every legacy root and
child; omit children only when none exist. Do not include credentials, keys or
account contents. Ambiguous or historically shared trees need independent
resolution, not an invented assignment.

Run a read-only preflight from the corresponding-source directory:

```sh
php cli/account-storage.php --offline --dry-run \
  --storage=/absolute/private/storage --map=/private/authoritative.json
```

The storage base must exist. This check is advisory: it does not acquire
adoption locks, establish quiescence, prove write access or durable publication.
After reviewing its result and the ownership evidence, run the same command
without `--dry-run` to adopt. Adoption requires a local filesystem with
locking, atomic rename and working file/directory `fsync`; unsupported or
ambiguous layouts are refused. Do not delete or alter data merely to bypass a
refusal.

For an interrupted adoption, keep services stopped and use `--resume` with the
same complete map after investigating the failure. For an ordinary restore,
`--reattest` requires the existing registry and a complete authoritative map
for exactly the same identities, paths and children; it cannot assign new
paths. A v2 main entry uses `"layout": "v2"` and its full main-identity digest
as `source`; a v2 child uses its full parent-scoped digest.
`--reattest --resume` repeats an interrupted re-attestation. Preserve the
existing registry and data if the tool refuses;
never remove a pending marker to force startup.
