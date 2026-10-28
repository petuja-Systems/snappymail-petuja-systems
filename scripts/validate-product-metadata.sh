#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${1:-$ROOT}"

python3 - "$ROOT" <<'PY'
import json
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])
metadata_path = root / "snappymail/v/0.0.0/app/petuja-product.json"
package_path = root / "package.json"
changelog_path = root / "CHANGELOG.md"
integrity_path = root / "snappymail/v/0.0.0/app/libraries/snappymail/integrity.php"

metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
package = json.loads(package_path.read_text(encoding="utf-8"))

required = ("product", "version", "snappymailVersion", "minimumPhpVersion")
missing = [key for key in required if not isinstance(metadata.get(key), str) or not metadata[key]]
if missing:
    raise SystemExit(f"Missing/invalid product metadata fields: {', '.join(missing)}")

if metadata["product"] != "petuja.email":
    raise SystemExit(f"Unexpected product name: {metadata['product']!r}")

semver = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$")
if not semver.fullmatch(metadata["version"]):
    raise SystemExit(f"Invalid petuja.email version: {metadata['version']!r}")

if metadata["snappymailVersion"] != package.get("version"):
    raise SystemExit(
        "SnappyMail version mismatch: "
        f"petuja-product.json={metadata['snappymailVersion']!r}, "
        f"package.json={package.get('version')!r}"
    )

php_floor_pattern = re.compile(r"public\s+const\s+MINIMUM_PHP_VERSION\s*=\s*'([0-9]+\.[0-9]+\.[0-9]+)'\s*;")
integrity_source = integrity_path.read_text(encoding="utf-8")
php_floor_match = php_floor_pattern.search(integrity_source)
if not php_floor_match:
    raise SystemExit(f"Could not read MINIMUM_PHP_VERSION from {integrity_path}")
php_floor = php_floor_match.group(1)
if not semver.fullmatch(metadata["minimumPhpVersion"]):
    raise SystemExit(f"Invalid minimum PHP version: {metadata['minimumPhpVersion']!r}")
if metadata["minimumPhpVersion"] != php_floor:
    raise SystemExit(
        "PHP minimum version mismatch: "
        f"petuja-product.json={metadata['minimumPhpVersion']!r}, "
        f"Integrity::MINIMUM_PHP_VERSION={php_floor!r}"
    )

changelog = changelog_path.read_text(encoding="utf-8")
heading = f"## petuja.email {metadata['version']}"
if heading not in changelog:
    raise SystemExit(f"CHANGELOG.md is missing heading: {heading}")

print(
    f"Validated {metadata['product']} {metadata['version']} "
    f"based on SnappyMail {metadata['snappymailVersion']} "
    f"(PHP {metadata['minimumPhpVersion']} or newer)"
)
PY
