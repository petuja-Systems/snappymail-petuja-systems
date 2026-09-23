#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

"$ROOT/scripts/validate-product-metadata.sh"

python3 - "$ROOT" <<'PY'
import datetime
import json
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])
metadata = json.loads(
    (root / "snappymail/v/0.0.0/app/petuja-product.json").read_text(encoding="utf-8")
)
version = metadata["version"]

changelog = (root / "CHANGELOG.md").read_text(encoding="utf-8")
unreleased = f"## petuja.email {version} — unreleased"
if unreleased in changelog:
    raise SystemExit(
        f"Release {version} is still marked unreleased in CHANGELOG.md"
    )

match = re.search(
    rf"^## petuja\.email {re.escape(version)} — (\d{{4}}-\d{{2}}-\d{{2}})$",
    changelog,
    flags=re.MULTILINE,
)
if not match:
    raise SystemExit(
        f"CHANGELOG.md must contain a dated release heading for petuja.email {version}"
    )

try:
    release_date = datetime.date.fromisoformat(match.group(1))
except ValueError as exc:
    raise SystemExit(f"Invalid release date: {match.group(1)}") from exc

security = (root / "SECURITY.md").read_text(encoding="utf-8")
if "currently being prepared as the first product release" in security:
    raise SystemExit("SECURITY.md still contains pre-release wording")

print(f"Release-ready validation passed for petuja.email {version} ({release_date})")
PY
