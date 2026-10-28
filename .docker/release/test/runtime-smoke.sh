#!/bin/sh
set -eu

IMAGE=${1:-}
if [ -z "$IMAGE" ]; then
    echo "Usage: $0 IMAGE" >&2
    exit 2
fi
if ! command -v docker >/dev/null 2>&1; then
    echo "Docker is required to run the container runtime smoke test." >&2
    exit 127
fi
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "Docker image not found: $IMAGE" >&2
    exit 1
fi

RUN_ID=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
NETWORK_NAME="petuja-email-runtime-${RUN_ID}"
APP_CONTAINER_NAME="${NETWORK_NAME}-app"
PEER_CONTAINER_NAME="${NETWORK_NAME}-peer"
VOLUME_NAME="${NETWORK_NAME}-data"
APP_CONTAINER_ID=
PEER_CONTAINER_ID=
NETWORK_CREATED=
VOLUME_CREATED=
APP_CREATED=
PEER_CREATED=

cleanup() {
    status=$?
    trap - EXIT HUP INT TERM
    if [ -n "$PEER_CREATED" ]; then
        docker rm -fv "$PEER_CONTAINER_ID" >/dev/null 2>&1 || true
    fi
    if [ -n "$APP_CREATED" ]; then
        docker rm -fv "$APP_CONTAINER_ID" >/dev/null 2>&1 || true
    fi
    if [ -n "$VOLUME_CREATED" ]; then
        docker volume rm "$VOLUME_NAME" >/dev/null 2>&1 || true
    fi
    if [ -n "$NETWORK_CREATED" ]; then
        docker network rm "$NETWORK_NAME" >/dev/null 2>&1 || true
    fi
    exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

PROBE_NAME="runtime-smoke-probe-${RUN_ID}.php"
PROBE_PATH="/snappymail/${PROBE_NAME}"
FIXTURE_NAME="runtime-smoke-${RUN_ID}.txt"
FIXTURE_PATH="/var/lib/snappymail/_data_/_default_/configs/${FIXTURE_NAME}"
FIXTURE_SENTINEL="runtime-smoke-${RUN_ID}-sentinel"
SPOOFED_FORWARDED_FOR=203.0.113.77

docker network create --internal "$NETWORK_NAME" >/dev/null
NETWORK_CREATED=1
docker volume create "$VOLUME_NAME" >/dev/null
VOLUME_CREATED=1
APP_CONTAINER_ID=$(docker create \
    --name "$APP_CONTAINER_NAME" \
    --network "$NETWORK_NAME" \
    --network-alias app \
    --mount "type=volume,source=${VOLUME_NAME},target=/var/lib/snappymail" \
    --mount "type=volume,source=${VOLUME_NAME},target=/snappymail/data,readonly" \
    "$IMAGE")
APP_CREATED=1
docker start "$APP_CONTAINER_ID" >/dev/null
# The peer needs only the PHP CLI; override the image-declared data volume to avoid an anonymous volume.
PEER_CONTAINER_ID=$(docker create \
    --name "$PEER_CONTAINER_NAME" \
    --network "$NETWORK_NAME" \
    --mount "type=tmpfs,target=/var/lib/snappymail" \
    --entrypoint php \
    "$IMAGE" -r 'sleep(3600);')
PEER_CREATED=1
docker start "$PEER_CONTAINER_ID" >/dev/null

docker exec -i "$PEER_CONTAINER_ID" sh -c 'cat > /tmp/runtime-smoke-client.php' <<'PHP_CLIENT'
<?php
function fail(string $message): never
{
    fwrite(STDERR, $message . "\n");
    exit(1);
}

function request(string $path, string $headers = ''): array
{
    $context = stream_context_create([
        'http' => [
            'method' => 'GET',
            'header' => $headers,
            'timeout' => 5,
            'ignore_errors' => true,
            'follow_location' => 0,
        ],
    ]);
    $body = @file_get_contents('http://app:8888' . $path, false, $context);
    $responseHeaders = $http_response_header ?? [];
    $status = 0;
    foreach ($responseHeaders as $header) {
        if (preg_match('/^HTTP\/\S+\s+(\d{3})/', $header, $matches)) {
            $status = (int) $matches[1];
        }
    }
    if (false === $body && 0 === $status) {
        fail('HTTP request failed: ' . $path);
    }
    return [$status, false === $body ? '' : $body];
}

$action = $argv[1] ?? '';
switch ($action) {
    case 'ready':
        [$status, $body] = request('/');
        if (200 !== $status || '' === $body) {
            fail('The application did not become ready.');
        }
        echo "Application is ready.\n";
        break;

    case 'root':
        [$status, $body] = request('/');
        if (200 !== $status || false === stripos($body, '<html') || false === stripos($body, 'petuja.email')) {
            fail('The root page did not return the expected application HTML.');
        }
        echo "Root page returned the expected application HTML.\n";
        break;

    case 'svg':
        $version = $argv[2] ?? '';
        if (!preg_match('/^[A-Za-z0-9][A-Za-z0-9.+-]*$/D', $version)) {
            fail('The image contains an invalid SnappyMail version.');
        }
        [$status, $body] = request('/snappymail/v/' . $version . '/static/images/petuja-systems-logo.svg');
        if (200 !== $status || false === stripos($body, '<svg') || false === stripos($body, 'xmlns="http://www.w3.org/2000/svg"')) {
            fail('The versioned SVG did not return the expected content.');
        }
        echo "Versioned SVG returned the expected content.\n";
        break;

    case 'probe':
        $probeName = $argv[2] ?? '';
        $spoofedAddress = $argv[3] ?? '';
        $expectedPeerAddress = $argv[4] ?? '';
        if (!preg_match('/^runtime-smoke-probe-[a-f0-9]+\.php$/D', $probeName)
            || '' === $spoofedAddress || '' === $expectedPeerAddress) {
            fail('Invalid PHP probe parameters.');
        }
        [$status, $body] = request('/' . $probeName, 'X-Forwarded-For: ' . $spoofedAddress . "\r\n");
        $result = json_decode($body, true);
        if (200 !== $status || !is_array($result)
            || ($result['forwarded_for'] ?? null) !== $spoofedAddress
            || ($result['remote_addr'] ?? null) !== $expectedPeerAddress) {
            fail('PHP probe did not preserve the spoofed forwarded header and actual peer address.');
        }
        echo "PHP probe executed with the expected forwarded and peer addresses.\n";
        break;

    case 'fpm-port':
        $socket = @stream_socket_client('tcp://app:9000', $errorNumber, $errorMessage, 2, STREAM_CLIENT_CONNECT);
        if (is_resource($socket)) {
            fclose($socket);
            fail('The peer connected to the application PHP-FPM port.');
        }
        echo "Peer could not connect to PHP-FPM port 9000.\n";
        break;

    case 'data-denied':
        $path = $argv[2] ?? '';
        $sentinel = $argv[3] ?? '';
        if (!preg_match('#^/data/_data_/_default_/configs/runtime-smoke-[a-f0-9]+\.txt$#D', $path)
            || '' === $sentinel) {
            fail('Invalid data fixture parameters.');
        }
        [$status, $body] = request($path);
        if (403 !== $status || false !== strpos($body, $sentinel)) {
            fail('The synthetic data fixture was not forbidden.');
        }
        echo "Synthetic data URL was forbidden without returning its sentinel.\n";
        break;

    case 'include':
        [$status, $body] = request('/include.php');
        if (200 !== $status || '' !== $body) {
            fail('/include.php did not execute as PHP with an empty response.');
        }
        echo "/include.php executed with an empty response.\n";
        break;

    default:
        fail('Unknown smoke-test action.');
}
PHP_CLIENT

# The peer uses the final image's PHP CLI and standard HTTP streams, with no extra peer image.
run_peer_check() {
    timeout 15s docker exec "$PEER_CONTAINER_ID" php /tmp/runtime-smoke-client.php "$@"
}

READY=
ATTEMPT=1
while [ "$ATTEMPT" -le 30 ]; do
    if [ "$(docker inspect -f '{{.State.Running}}' "$APP_CONTAINER_ID" 2>/dev/null || true)" != 'true' ]; then
        echo "Application container exited during startup; recent logs follow:" >&2
        docker logs "$APP_CONTAINER_ID" >&2 || true
        echo "Container runtime smoke test failed." >&2
        exit 1
    fi
    if timeout 8s docker exec "$PEER_CONTAINER_ID" php /tmp/runtime-smoke-client.php ready >/dev/null 2>&1; then
        READY=1
        break
    fi
    ATTEMPT=$((ATTEMPT + 1))
    sleep 2
done
if [ -z "$READY" ]; then
    echo "Application did not become ready within 5 minutes; recent logs follow:" >&2
    docker logs "$APP_CONTAINER_ID" >&2 || true
    echo "Container runtime smoke test failed." >&2
    exit 1
fi

METADATA=$(timeout 15s docker exec "$APP_CONTAINER_ID" php -r '
$files = glob("/snappymail/snappymail/v/*/app/petuja-product.json");
if (1 !== count($files)) {
    fwrite(STDERR, "Expected one product metadata file in the release image.\n");
    exit(1);
}
$data = json_decode(file_get_contents($files[0]), true, 512, JSON_THROW_ON_ERROR);
if (!is_array($data)
    || "petuja.email" !== ($data["product"] ?? null)
    || !is_string($data["version"] ?? null)
    || !is_string($data["snappymailVersion"] ?? null)
    || basename(dirname(dirname($files[0]))) !== $data["snappymailVersion"]) {
    fwrite(STDERR, "Product metadata does not match its versioned image directory.\n");
    exit(1);
}
printf("%s\n%s\n", $data["version"], $data["snappymailVersion"]);
')
PRODUCT_VERSION=$(printf '%s\n' "$METADATA" | sed -n '1p')
SNAPPYMAIL_VERSION=$(printf '%s\n' "$METADATA" | sed -n '2p')
if [ -z "$PRODUCT_VERSION" ] || [ -z "$SNAPPYMAIL_VERSION" ]; then
    echo "Could not derive application versions from the release image." >&2
    exit 1
fi
echo "Testing petuja.email $PRODUCT_VERSION based on SnappyMail $SNAPPYMAIL_VERSION."

run_peer_check root
run_peer_check svg "$SNAPPYMAIL_VERSION"

# The probe is a disposable PHP file in the app container and reveals no application data.
docker exec -i "$APP_CONTAINER_ID" sh -c 'cat > "$1"' sh "$PROBE_PATH" <<'PHP_PROBE'
<?php
header('Content-Type: application/json');
echo json_encode([
    'forwarded_for' => $_SERVER['HTTP_X_FORWARDED_FOR'] ?? null,
    'remote_addr' => $_SERVER['REMOTE_ADDR'] ?? null,
], JSON_THROW_ON_ERROR);
PHP_PROBE
PEER_IP=$(docker inspect -f "{{with index .NetworkSettings.Networks \"${NETWORK_NAME}\"}}{{.IPAddress}}{{end}}" "$PEER_CONTAINER_ID")
if [ -z "$PEER_IP" ]; then
    echo "Could not identify the peer container address." >&2
    exit 1
fi
run_peer_check probe "$PROBE_NAME" "$SPOOFED_FORWARDED_FOR" "$PEER_IP"
run_peer_check fpm-port

# The read-only alias presents the synthetic fixture under nginx's /data path; the
# HTTP 403 assertion verifies Nginx blocks it. The disposable volume removes the fixture.
docker exec "$APP_CONTAINER_ID" php -r '
$path = $argv[1];
$value = $argv[2];
$directory = dirname($path);
if (!is_dir($directory) && !mkdir($directory, 0777, true) && !is_dir($directory)) {
    exit(1);
}
if (false === file_put_contents($path, $value)) {
    exit(1);
}
' "$FIXTURE_PATH" "$FIXTURE_SENTINEL"
run_peer_check data-denied "/data/_data_/_default_/configs/${FIXTURE_NAME}" "$FIXTURE_SENTINEL"
run_peer_check include

echo "Container runtime smoke test passed."
