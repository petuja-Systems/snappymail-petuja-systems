#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

python3 - "$ROOT" <<'PY'
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])
path = root / "snappymail/v/0.0.0/app/libraries/RainLoop/ServiceActions.php"
source = path.read_text(encoding="utf-8")

method = re.search(
    r"public function ServiceProxyExternal\(\) : string\s*\{(?P<body>.*?)"
    r"\n\t\}\n\n\tpublic function ",
    source,
    flags=re.DOTALL,
)
if not method:
    raise SystemExit("Could not locate ServiceProxyExternal()")

body = method.group("body")
guard = re.search(r"if\s*\((?P<condition>.*?)\)\s*\{", body, flags=re.DOTALL)
if not guard:
    raise SystemExit("Could not locate ServiceProxyExternal() guard")

condition = guard.group("condition")
required = (
    "$sData",
    "use_local_proxy_for_external_images",
    "$this->oActions->getAccountFromToken()",
)
missing = [item for item in required if item not in condition]
if missing:
    raise SystemExit(
        "External-image proxy authentication guard is incomplete: "
        + ", ".join(missing)
    )

print("Validated authenticated external-image proxy security backport")
PY
