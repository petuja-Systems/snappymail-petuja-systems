#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

python3 - "$ROOT" <<'PY'
import json
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])
metadata_path = root / "snappymail/v/0.0.0/app/petuja-product.json"
package_path = root / "package.json"
changelog_path = root / "CHANGELOG.md"

metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
package = json.loads(package_path.read_text(encoding="utf-8"))

required = ("product", "version", "snappymailVersion")
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

changelog = changelog_path.read_text(encoding="utf-8")
heading = f"## petuja.email {metadata['version']}"
if heading not in changelog:
    raise SystemExit(f"CHANGELOG.md is missing heading: {heading}")

print(
    f"Validated {metadata['product']} {metadata['version']} "
    f"based on SnappyMail {metadata['snappymailVersion']}"
)
PY
