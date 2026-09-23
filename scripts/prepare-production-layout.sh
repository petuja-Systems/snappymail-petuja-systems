#!/usr/bin/env bash
set -euo pipefail

: "${LIVE_ROOT:?Set LIVE_ROOT to the existing production document root}"
: "${RELEASE_BASE:?Set RELEASE_BASE to the directory that will contain versioned releases}"
: "${CURRENT_LINK:?Set CURRENT_LINK to the symlink used as the future document root}"

DATA_PATH="${DATA_PATH:-$LIVE_ROOT/data}"
DATA_PATH="${DATA_PATH%/}"

if [[ ! -d "$LIVE_ROOT" || ! -f "$LIVE_ROOT/index.php" ]]; then
  echo "Existing production root is not a SnappyMail application: $LIVE_ROOT" >&2
  exit 1
fi

if [[ ! -d "$DATA_PATH" || ! -f "$DATA_PATH/INSTALLED" ]]; then
  echo "Production data directory or INSTALLED marker is missing: $DATA_PATH" >&2
  exit 1
fi

if [[ "$CURRENT_LINK" != "$LIVE_ROOT/"* ]]; then
  echo "CURRENT_LINK must be located below LIVE_ROOT for this migration" >&2
  exit 1
fi

if [[ -e "$CURRENT_LINK" || -L "$CURRENT_LINK" ]]; then
  echo "CURRENT_LINK already exists: $CURRENT_LINK" >&2
  exit 1
fi

engine_version="$(tr -d '\r\n' < "$DATA_PATH/INSTALLED")"
if [[ ! "$engine_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Unexpected data/INSTALLED value: $engine_version" >&2
  exit 1
fi

if [[ ! -d "$LIVE_ROOT/snappymail/v/$engine_version" ]]; then
  echo "Current application does not contain snappymail/v/$engine_version" >&2
  exit 1
fi

if [[ "$DATA_PATH" == *"'"* ]]; then
  echo "DATA_PATH containing a single quote is not supported" >&2
  exit 1
fi

mkdir -p "$RELEASE_BASE/releases"
chmod 770 "$RELEASE_BASE" "$RELEASE_BASE/releases"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
legacy_release="$RELEASE_BASE/releases/legacy-snappymail-$engine_version-$timestamp"
mkdir "$legacy_release"

cleanup() {
  if [[ -d "$legacy_release" && ! -L "$CURRENT_LINK" ]]; then
    rm -rf "$legacy_release"
  fi
}
trap cleanup ERR

tar -C "$LIVE_ROOT" \
  --exclude='./data' \
  --exclude='./current' \
  --exclude='./rainloop.zip' \
  -cf - . | tar -C "$legacy_release" -xf -

cat > "$legacy_release/include.php" <<PHP
<?php
// Production-only configuration generated during the petuja.email release-layout migration.
define('APP_DATA_FOLDER_PATH', '${DATA_PATH}/');
PHP
chmod 600 "$legacy_release/include.php"

php -l "$legacy_release/index.php" >/dev/null
php -l "$legacy_release/include.php" >/dev/null

if ! grep -Fq "define('APP_VERSION', '$engine_version')" "$legacy_release/index.php"; then
  echo "Legacy snapshot index.php does not point to SnappyMail $engine_version" >&2
  exit 1
fi

ln -s "$legacy_release" "$CURRENT_LINK"

echo "Prepared production release layout."
echo "Legacy release: $legacy_release"
echo "Persistent data: $DATA_PATH"
echo "Current link: $CURRENT_LINK -> $(readlink -f "$CURRENT_LINK")"
echo
echo "No web-server root was changed by this script."
echo "After verifying the snapshot, change the CloudPanel Root Directory to /current."
