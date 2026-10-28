# S/MIME certificate trust and legacy reconfirmation

Message verification checks cryptographic signature integrity. A valid signature,
including a self-signed signature, does not establish ownership of a claimed
email address. Verification never imports embedded certificates or grants
future recipient-encryption eligibility.

Only the existing explicit PEM import action adds a certificate to the
account's `.smime/explicit-v1/` store. Certificates are exported as canonical
PEM and addressed by their full SHA-256 certificate fingerprint. Re-importing
the same certificate is idempotent; certificates sharing a subject key
identifier remain distinct. Multiple explicitly imported certificates for the
same email retain the existing multiple-recipient-certificate behavior.

The application does not establish PKI identity trust on the user's behalf.
Verify a certificate's identity/fingerprint through an appropriately trusted
source before importing it. Import is an explicit trust decision, not proof
that the claimed address belongs to its holder. Existing certificate-purpose
and email matching behavior remains unchanged.

## Existing stored certificates

Old root-level `.crt` files and `certificates.json` mixed automatically discovered
and explicitly imported certificates without provenance. Their origin cannot
be recovered reliably. They remain byte-for-byte in place, but are excluded
from the certificate list and all stored-ID recipient lookup. No legacy data
is moved, merged, deleted, renamed, or automatically trusted.

To restore eligibility, obtain the public PEM certificate from a verified copy
and use the existing Security settings certificate-import popup. If necessary,
an authorized operator can retrieve the old public certificate from that
account's preserved private storage under their established ownership process.
Do not treat its presence, filename, or successful message verification as an
identity check. This behavior does not retrieve or migrate real account data.

Reload the application to refresh its existing client certificate list after
import. Stale or unknown stored IDs fail before encryption; they never silently
fall back to a legacy certificate or plaintext sending. Existing open compose
windows from an older application version must be refreshed.

The sender's own identity certificate/key remains in the separate identity
settings. Signing, decryption and explicitly supplied per-message PEM recipients
remain supported and do not grant persistent recipient trust. Trust remains
main-account scoped and shared with that main account's additional accounts.

The new store assumes service-private storage and trusted current code.
Certificate file reads validate the fingerprint-bound filename. The directory
and cache are not an authorization boundary against a privileged host actor.
Private-key operations use the account's configured identity; request data is
not treated as a private-key path or written to logs as key material.
