#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT="${1:-}"
REF="${2:-HEAD}"

if [[ -z "$OUTPUT" ]]; then
  echo "Usage: $0 OUTPUT_DIRECTORY [GIT_REF]" >&2
  exit 2
fi

OUTPUT="$(python3 - "$OUTPUT" <<'PY'
import os
import sys
print(os.path.abspath(sys.argv[1]))
PY
)"

case "$OUTPUT" in
  "/"|"")
    echo "Refusing unsafe export destination: $OUTPUT" >&2
    exit 2
    ;;
esac

if [[ "$OUTPUT" == "$ROOT" || "$OUTPUT" == "$ROOT/"* ]]; then
  echo "Export destination must be outside the repository worktree: $OUTPUT" >&2
  exit 2
fi

git -C "$ROOT" rev-parse --verify "$REF^{commit}" >/dev/null

rm -rf "$OUTPUT"
mkdir -p "$OUTPUT"

git -C "$ROOT" archive --format=tar "$REF" | tar -xf - -C "$OUTPUT"

echo "Exported public source from $REF to $OUTPUT"
