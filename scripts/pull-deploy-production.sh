#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  pull-deploy-production.sh <product-version> DEPLOY

Example:
  pull-deploy-production.sh 1.0.0 DEPLOY

The immutable public petuja.email release tag is used to resolve the exact
private source commit. The private repository is then fetched read-only, built
locally, validated, installed into a new immutable release directory, and
activated through the production current symlink.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

PRODUCT_VERSION="${1:-}"
CONFIRM="${2:-}"

if [[ ! "$PRODUCT_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?$ ]]; then
  echo "Invalid or missing product version." >&2
  usage >&2
  exit 1
fi

if [[ "$CONFIRM" != "DEPLOY" ]]; then
  echo "Refusing production deployment without explicit DEPLOY confirmation." >&2
  usage >&2
  exit 1
fi

RELEASE_BASE="${RELEASE_BASE:-$HOME/petuja-email}"
SOURCE_DIR="${SOURCE_DIR:-$RELEASE_BASE/source}"
DATA_PATH="${DATA_PATH:-$HOME/htdocs/petuja.email/data}"
CURRENT_LINK="${CURRENT_LINK:-$HOME/htdocs/petuja.email/current}"
HEALTH_URL="${HEALTH_URL:-https://petuja.email}"
PRIVATE_REMOTE="${PRIVATE_REMOTE:-git@github.com:petuja-Systems/petuja.email.git}"
PUBLIC_REMOTE="${PUBLIC_REMOTE:-https://github.com/petuja-Systems/snappymail-petuja-systems.git}"
PUBLIC_TAG="petuja-email-v$PRODUCT_VERSION"
NODE_BIN="${NODE_BIN:-$HOME/.local/node/current/bin}"

export PATH="$NODE_BIN:$PATH"

for command in git php python3 curl unzip sha256sum flock corepack; do
  command -v "$command" >/dev/null || {
    echo "Required command is missing: $command" >&2
    exit 1
  }
done

if [[ ! -d "$SOURCE_DIR/.git" ]]; then
  echo "Private source checkout is missing: $SOURCE_DIR" >&2
  exit 1
fi

actual_remote="$(git -C "$SOURCE_DIR" remote get-url origin)"
if [[ "$actual_remote" != "$PRIVATE_REMOTE" ]]; then
  echo "Unexpected private repository remote: $actual_remote" >&2
  exit 1
fi

if [[ ! -L "$CURRENT_LINK" ]]; then
  echo "Production current link is missing: $CURRENT_LINK" >&2
  exit 1
fi

if [[ ! -d "$DATA_PATH" || ! -f "$DATA_PATH/INSTALLED" ]]; then
  echo "Persistent production data is missing: $DATA_PATH" >&2
  exit 1
fi

mkdir -p "$RELEASE_BASE"
exec 9>"$RELEASE_BASE/.deploy.lock"
if ! flock -n 9; then
  echo "Another petuja.email deployment is already running." >&2
  exit 1
fi

TMP="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP"
}
trap cleanup EXIT

echo "=== Resolve immutable public release ==="
git clone --quiet --depth 1 --branch "$PUBLIC_TAG" "$PUBLIC_REMOTE" "$TMP/public-source"

PUBLIC_COMMIT_MESSAGE="$(git -C "$TMP/public-source" log -1 --format=%B)"
mapfile -t PRIVATE_COMMIT_LINES < <(
  grep -E '^Private source commit: [0-9a-f]{40}$' <<<"$PUBLIC_COMMIT_MESSAGE" || true
)

if [[ "${#PRIVATE_COMMIT_LINES[@]}" -ne 1 ]]; then
  echo "Public tag $PUBLIC_TAG does not identify exactly one private source commit." >&2
  exit 1
fi

SOURCE_COMMIT="${PRIVATE_COMMIT_LINES[0]#Private source commit: }"
if [[ ! "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Invalid private source commit in public release metadata." >&2
  exit 1
fi

python3 - "$TMP/public-source/snappymail/v/0.0.0/app/petuja-product.json" "$PRODUCT_VERSION" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
expected_version = sys.argv[2]
data = json.loads(path.read_text(encoding="utf-8"))

if data.get("product") != "petuja.email":
    raise SystemExit(f"Unexpected public product identity: {data.get('product')!r}")
if data.get("version") != expected_version:
    raise SystemExit(
        f"Public tag version mismatch: {data.get('version')!r} != {expected_version!r}"
    )
PY

echo "Public tag:     $PUBLIC_TAG"
echo "Private commit: $SOURCE_COMMIT"

echo
echo "=== Prepare exact private source ==="
git -C "$SOURCE_DIR" fetch --prune origin
git -C "$SOURCE_DIR" cat-file -e "$SOURCE_COMMIT^{commit}"
git -C "$SOURCE_DIR" reset --hard
git -C "$SOURCE_DIR" clean -ffdx
git -C "$SOURCE_DIR" checkout --detach "$SOURCE_COMMIT"

if [[ "$(git -C "$SOURCE_DIR" rev-parse HEAD)" != "$SOURCE_COMMIT" ]]; then
  echo "Private checkout did not resolve to the required commit." >&2
  exit 1
fi

cd "$SOURCE_DIR"

./scripts/validate-product-metadata.sh
./scripts/validate-release-ready.sh

readarray -t RELEASE_METADATA < <(
  python3 - "$PRODUCT_VERSION" <<'PY'
import json
import pathlib
import sys

requested = sys.argv[1]
data = json.loads(
    pathlib.Path("snappymail/v/0.0.0/app/petuja-product.json").read_text(
        encoding="utf-8"
    )
)

if data.get("version") != requested:
    raise SystemExit(
        f"Requested version {requested!r} does not match private source "
        f"{data.get('version')!r}"
    )

print(data["version"])
print(data["snappymailVersion"])
PY
)

if [[ "${#RELEASE_METADATA[@]}" -ne 2 ]]; then
  echo "Could not resolve release metadata." >&2
  exit 1
fi

PRODUCT_VERSION="${RELEASE_METADATA[0]}"
SNAPPYMAIL_VERSION="${RELEASE_METADATA[1]}"

release_dir="$RELEASE_BASE/releases/petuja-email-$PRODUCT_VERSION-${SOURCE_COMMIT:0:12}"
if [[ -e "$release_dir" ]]; then
  echo "Release already exists: $release_dir" >&2
  echo "Nothing was changed." >&2
  exit 1
fi

echo
echo "=== Install frozen build dependencies ==="
corepack yarn install --frozen-lockfile

echo
echo "=== PHP syntax check ==="
find . -type f -name '*.php' -not -path './node_modules/*' -print0 \
  | xargs -0 -n1 -P4 php -l >/tmp/petuja-email-php-lint.txt
tail -n 10 /tmp/petuja-email-php-lint.txt

echo
echo "=== Build production release ==="
export PATH="$PWD/node_modules/.bin:$PATH"
php release.php

ARCHIVE="$PWD/build/dist/releases/webmail/$SNAPPYMAIL_VERSION/snappymail-$SNAPPYMAIL_VERSION.zip"
test -f "$ARCHIVE"

echo
echo "=== Validate release archive ==="
unzip -l "$ARCHIVE" | grep -F "snappymail/v/$SNAPPYMAIL_VERSION/app/petuja-product.json"
unzip -l "$ARCHIVE" | grep -F "LICENSE"

git diff --check
git diff --exit-code

ARCHIVE_SHA256="$(sha256sum "$ARCHIVE" | awk '{print $1}')"

echo "Archive SHA-256: $ARCHIVE_SHA256"

echo
echo "=== Activate immutable release ==="
ARCHIVE="$ARCHIVE" \
ARCHIVE_SHA256="$ARCHIVE_SHA256" \
PRODUCT_VERSION="$PRODUCT_VERSION" \
SNAPPYMAIL_VERSION="$SNAPPYMAIL_VERSION" \
SOURCE_COMMIT="$SOURCE_COMMIT" \
RELEASE_BASE="$RELEASE_BASE" \
DATA_PATH="$DATA_PATH" \
CURRENT_LINK="$CURRENT_LINK" \
HEALTH_URL="$HEALTH_URL" \
"$SOURCE_DIR/scripts/deploy-production-release.sh"

echo
echo "=== Deployment complete ==="
echo "Version:       $PRODUCT_VERSION"
echo "Source commit: $SOURCE_COMMIT"
echo "Current:       $CURRENT_LINK -> $(readlink -f "$CURRENT_LINK")"
