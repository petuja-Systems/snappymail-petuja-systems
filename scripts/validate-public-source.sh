#!/usr/bin/env bash
set -euo pipefail

SOURCE="${1:-}"

if [[ -z "$SOURCE" || ! -d "$SOURCE" ]]; then
  echo "Usage: $0 EXPORTED_SOURCE_DIRECTORY" >&2
  exit 2
fi

SOURCE="$(cd "$SOURCE" && pwd)"

python3 - "$SOURCE" <<'PY'
from pathlib import Path
import json
import os
import re
import sys

root = Path(sys.argv[1])

required = [
    "LICENSE",
    "README.md",
    "CHANGELOG.md",
    "SECURITY.md",
    "CONTRIBUTING.md",
    "package.json",
    "yarn.lock",
    "gulpfile.js",
    "release.php",
    "cli/release.php",
    "dev",
    "docs/CHANGE_WORKFLOW.md",
    "snappymail/v/0.0.0/app/petuja-product.json",
    "snappymail/v/0.0.0/static/fonts/Rubik/OFL.txt",
]

for rel in required:
    if not (root / rel).exists():
        raise SystemExit(f"Required corresponding-source path is missing: {rel}")

for rel in ["AGENTS.md", ".github", "include.php"]:
    if (root / rel).exists():
        raise SystemExit(f"Internal/runtime-only path leaked into public source: {rel}")

allowed_sensitive = {
    "build/SnappyMail.asc",
    "examples/crypto/3140898548F06E97-private.asc",
    "examples/crypto/3140898548F06E97-public.asc",
    "examples/crypto/5F3A5CDC09AD8AE3-private.asc",
    "examples/crypto/5F3A5CDC09AD8AE3-public.asc",
    "examples/crypto/A0B428E12402D875-private.asc",
    "examples/crypto/A0B428E12402D875-public.asc",
    "examples/crypto/smime.crt",
    "examples/crypto/smime.key",
    "snappymail/v/0.0.0/app/libraries/snappymail/smime/snappymail.crt",
    "snappymail/v/0.0.0/app/libraries/snappymail/smime/snappymail.key",
}

forbidden_suffixes = {
    ".log", ".sql", ".sqlite", ".sqlite3", ".db",
    ".p12", ".pfx", ".pkcs12", ".jks", ".pem",
}
sensitive_suffixes = {".key", ".crt", ".cer", ".asc"}
private_key_header = re.compile(
    rb"^-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----"
)

for path in root.rglob("*"):
    if path.is_symlink():
        target = os.readlink(path)
        if os.path.isabs(target):
            raise SystemExit(
                f"Absolute symlink is not allowed in public source: "
                f"{path.relative_to(root).as_posix()} -> {target}"
            )
        continue

    if not path.is_file():
        continue

    rel = path.relative_to(root).as_posix()
    name = path.name
    suffix = path.suffix.lower()

    if name == ".env" or name.startswith(".env.") or suffix in forbidden_suffixes:
        raise SystemExit(f"Unexpected runtime/secret-like file in public source: {rel}")

    if suffix in sensitive_suffixes and rel not in allowed_sensitive:
        raise SystemExit(f"Unexpected key/certificate/armored file in public source: {rel}")

    try:
        head = path.read_bytes()[:4096]
    except OSError as exc:
        raise SystemExit(f"Could not inspect {rel}: {exc}") from exc

    stripped = head.lstrip(b"\xef\xbb\xbf \t\r\n")
    if private_key_header.match(stripped) and rel not in allowed_sensitive:
        raise SystemExit(
            f"Unexpected private-key file outside approved upstream fixtures: {rel}"
        )

metadata_path = root / "snappymail/v/0.0.0/app/petuja-product.json"
package_path = root / "package.json"

metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
package = json.loads(package_path.read_text(encoding="utf-8"))

if metadata.get("product") != "petuja.email":
    raise SystemExit("Unexpected product metadata in public source")

if metadata.get("snappymailVersion") != package.get("version"):
    raise SystemExit("Public source product/engine version mismatch")

print(
    f"Validated public source for petuja.email {metadata['version']} "
    f"based on SnappyMail {metadata['snappymailVersion']}"
)
PY

"$SOURCE/scripts/validate-product-metadata.sh"

echo "Public corresponding-source snapshot validation passed"
