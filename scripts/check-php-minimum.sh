#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: check-php-minimum.sh <php-cli> <minimum-version>" >&2
  exit 2
fi

PHP_BIN="$1"
MINIMUM_PHP_VERSION="$2"

if [[ "$PHP_BIN" == -* ]] || ! PHP_BIN="$(type -P -- "$PHP_BIN")"; then
  echo "PHP CLI executable is missing: $PHP_BIN" >&2
  exit 1
fi

if [[ ! "$MINIMUM_PHP_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Invalid minimum PHP version: $MINIMUM_PHP_VERSION" >&2
  exit 2
fi

"$PHP_BIN" -r '
$minimum = $argv[1] ?? "";
if (!preg_match("/\\A[0-9]+\\.[0-9]+\\.[0-9]+\\z/", $minimum)) {
    fwrite(STDERR, "Invalid minimum PHP version.\n");
    exit(2);
}
if (version_compare(PHP_VERSION, $minimum, "<")) {
    fwrite(STDERR, "PHP CLI " . PHP_VERSION . " is below required " . $minimum . ".\n");
    exit(1);
}
printf("PHP CLI %s (PHP_VERSION_ID=%d; PHP_BINARY=%s) satisfies >= %s\n", PHP_VERSION, PHP_VERSION_ID, PHP_BINARY, $minimum);
' "$MINIMUM_PHP_VERSION"
