<?php
declare(strict_types=1);

// Own code, generated tiny raster images and bounded synthetic streams only.
error_reporting(E_ALL & ~E_DEPRECATED);
ini_set('display_errors', '0');
$libraries = dirname(__DIR__, 2) . '/snappymail/v/0.0.0/app/libraries';
spl_autoload_register(static function (string $class) use ($libraries): void {
    $path = str_replace('\\', '/', $class) . '.php';
    foreach ([$path, strtolower($path)] as $name) {
        if (is_file($libraries . '/' . $name)) { require_once $libraries . '/' . $name; return; }
    }
});
require $libraries . '/RainLoop/Actions/Raw.php';

const SOURCE_CAP = 8388608;
function tinyPng(): string {
    return base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=');
}
function headerPng(int $width, int $height): string {
    // Header metadata only. These bytes are NEVER passed to a native decoder.
    $chunk = 'IHDR' . pack('NNCCCCC', $width, $height, 8, 2, 0, 0, 0);
    return "\x89PNG\r\n\x1a\n" . pack('N', 13) . $chunk . pack('N', crc32($chunk));
}
class CountingImageStream {
    public $context;
    public static string $data = '';
    public static int $read = 0;
    private int $position = 0;
    public function stream_open($path, $mode, $options, &$openedPath): bool { return true; }
    public function stream_read(int $count): string {
        $chunk = substr(self::$data, $this->position, $count);
        $this->position += strlen($chunk); self::$read += strlen($chunk);
        return $chunk;
    }
    public function stream_eof(): bool { return $this->position >= strlen(self::$data); }
    public function stream_tell(): int { return $this->position; }
    public function stream_stat(): array { return ['size' => 0]; }
}
stream_wrapper_register('m711fixture', CountingImageStream::class);

class ThumbnailHarness {
    use \RainLoop\Actions\Raw;
    public static function transform($stream, bool $orientation = false) {
        return self::loadImage($stream, $orientation, 48);
    }
    public function getAccountFromToken() { return new class { public function Hash() { return 'synthetic-account'; } }; }
    public function GetActionParam($name, $default = '') { return 'synthetic-raw-key'; }
    public function decodeRawKey($key) {
        return ['accountHash' => ($_GET['mode'] ?? '') === 'unauthorized' ? 'other-account' : 'synthetic-account',
            'folder' => 'INBOX', 'uid' => 1, 'mimeIndex' => '1'];
    }
    public function verifyCacheByKey($key): void {}
    public function cacheByKey($key): void {}
    public function initMailClientConnection(): void {}
    public function logWrite(...$args): void {}
    public function Logger() { return new class { public function WriteExceptionShort(...$args): void {} }; }
    public function Config() { return new class { public function Get(...$args) { return ($_GET['mode'] ?? '') === 'rotate'; } }; }
    public function MailClient() {
        return new class {
            public function MessageMimeStream($callback, ...$args): bool {
                header('X-Fixture-Mail-Callback: yes');
                $mode = $_GET['mode'] ?? '';
                $data = $mode === 'oversize' || $mode === 'rotate' ? str_repeat('x', SOURCE_CAP + 1)
                    : ($mode === 'view' || $mode === 'download' ? "synthetic-attachment\x00original" : tinyPng());
                $stream = fopen('php://temp', 'w+b'); fwrite($stream, $data); rewind($stream);
                try { $callback($stream, $mode === 'rotate' ? 'image/jpeg' : 'image/png', 'synthetic.png', '1'); }
                finally { fclose($stream); }
                return true;
            }
        };
    }
}
if (PHP_SAPI === 'cli-server') {
    $harness = new ThumbnailHarness();
    $mode = $_GET['mode'] ?? '';
    $result = $mode === 'download' ? $harness->RawDownload()
        : ($mode === 'view' || $mode === 'rotate' ? $harness->RawView() : $harness->RawViewThumbnail());
    if (!$result) { http_response_code(403); echo 'rejected'; }
    exit;
}

$mode = $argv[1] ?? '';
if ($mode === 'probe') {
    echo json_encode(['gd' => extension_loaded('gd'), 'types' => function_exists('imagetypes') ? imagetypes() : 0]); exit;
}
if ($mode === 'spy') {
    class DecoderSpy implements \SnappyMail\Image {
        public static int $calls = 0;
        public static int $length = 0;
        public static array $steps = [];
        public static function createFromString(string &$data) { ++self::$calls; self::$length = strlen($data); return new self(); }
        public static function createFromStream($fp) { $data = stream_get_contents($fp); return self::createFromString($data); }
        public function valid(): bool { return true; }
        public function getOrientation(): int { return 6; }
        public function rotate(float $degrees): bool { self::$steps[] = ['rotate', $degrees]; return true; }
        public function show(?string $format = null): void {}
        public function cropThumbnailImage($width, $height) { self::$steps[] = ['crop', $width, $height]; }
        public function stripImage() { self::$steps[] = ['strip']; }
    }
    class_alias(DecoderSpy::class, 'SnappyMail\\Image\\GD2');
    $case = $argv[2] ?? '';
    $data = tinyPng();
    switch ($case) {
        case 'overflow': $data = substr_replace(headerPng(1, 1), str_repeat("\xff", 8), 16, 8); break;
        case 'edge': $data = headerPng(8193, 1); break;
        case 'pixels': $data = headerPng(4000, 2001); break;
        case 'zero': $data = headerPng(0, 1); break;
        case 'malformed': $data = 'synthetic non-image'; break;
        case 'svg': $data = '<svg width="1" height="1"/>'; break;
        case 'exact-geometry': $data = headerPng(4000, 2000); break;
        case 'exact-edge': $data = headerPng(8192, 1); break;
        case 'exact-bytes': $data .= str_repeat('x', SOURCE_CAP - strlen($data)); break;
        case 'oversize': $data .= str_repeat('x', SOURCE_CAP + 16384 - strlen($data)); break;
    }
    CountingImageStream::$data = $data;
    $stream = fopen('m711fixture://source', 'rb');
    if ($case === 'base64' || $case === 'quoted-printable') {
        CountingImageStream::$data = $case === 'base64' ? base64_encode($data) : quoted_printable_encode($data);
        $stream = \MailSo\Base\StreamWrappers\Binary::CreateStream($stream, 'convert.' . $case . '-decode');
    }
    $error = null;
    try { ThumbnailHarness::transform($stream, $case === 'orientation'); }
    catch (Throwable $exception) { $error = get_class($exception); }
    echo json_encode(['calls' => DecoderSpy::$calls, 'decoderBytes' => DecoderSpy::$length, 'read' => CountingImageStream::$read,
        'position' => ftell($stream), 'error' => $error, 'steps' => DecoderSpy::$steps]);
    fclose($stream); exit;
}
if ($mode === 'direct-stream') {
    CountingImageStream::$data = str_repeat('x', SOURCE_CAP + 16384);
    $stream = fopen('m711fixture://source', 'rb');
    $error = null;
    try { \SnappyMail\Image\GD2::createFromStream($stream); }
    catch (Throwable $exception) { $error = get_class($exception); }
    echo json_encode(['read' => CountingImageStream::$read, 'position' => ftell($stream), 'error' => $error]);
    fclose($stream); exit;
}
if ($mode === 'preflight') {
    $results = [];
    foreach ([[1,1,true], [8192,1,true], [4000,2000,true], [0,1,false], [-1,1,false],
        [8193,1,false], [4000,2001,false], [PHP_INT_MAX,PHP_INT_MAX,false]] as [$width,$height,$expected]) {
        $accepted = true;
        try { \SnappyMail\Image\Limits::checkGeometry($width, $height); }
        catch (InvalidArgumentException $exception) { $accepted = false; }
        $results[] = $accepted === $expected;
    }
    echo json_encode($results); exit;
}
if ($mode === 'native') {
    if (!extension_loaded('gd')) { fwrite(STDERR, "GD is required\n"); exit(2); }
    $format = $argv[2] ?? 'png';
    $wide = $format === 'wide';
    $image = imagecreatetruecolor($wide ? 257 : 12, $wide ? 1 : 8);
    $red = imagecolorallocate($image, 240, 10, 20);
    $green = imagecolorallocate($image, 10, 240, 20);
    imagefill($image, 0, 0, $red);
    imagefilledrectangle($image, $wide ? 128 : 3, 0, $wide ? 128 : 8, $wide ? 0 : 7, $green);
    ob_start();
    if ($format === 'gif') { imagegif($image); }
    elseif ($format === 'jpeg') { imagejpeg($image); }
    elseif ($format === 'webp') { imagewebp($image); }
    else { imagepng($image); }
    $data = ob_get_clean();
    $stream = fopen('php://temp', 'w+b'); fwrite($stream, $data); rewind($stream);
    $result = ThumbnailHarness::transform($stream);
    ob_start(); $result->show('png'); $png = ob_get_clean();
    $size = getimagesizefromstring($png);
    $output = imagecreatefromstring($png);
    $color = imagecolorsforindex($output, imagecolorat($output, 24, 24));
    echo json_encode(['width' => $size[0], 'height' => $size[1], 'type' => $size[2], 'center' => $color]);
    fclose($stream); exit;
}
throw new InvalidArgumentException('Unknown fixture mode');
