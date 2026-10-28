<?php
// Native Raw dispatch with inert synthetic MIME streams and isolated configuration.
if ('cli-server' !== PHP_SAPI || !getenv('M7_RAW_FIXTURE_ROOT')) {
    http_response_code(404);
    exit;
}
define('APP_INDEX_ROOT_PATH', getenv('M7_RAW_FIXTURE_ROOT') . '/');
define('APP_DATA_FOLDER_PATH', APP_INDEX_ROOT_PATH . 'data/');
$_ENV['SNAPPYMAIL_INCLUDE_AS_API'] = '1';
require dirname(__DIR__, 2) . '/snappymail/v/0.0.0/include.php';

function fixtureBytes(): string
{
    if (isset($_GET['png'])) {
        return base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=');
    }
    return isset($_GET['svg']) ? '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'
        : "synthetic-attachment\x00original";
}
function fixtureStream()
{
    if (isset($_GET['count'])) {
        stream_wrapper_register('rawfixture', RawCountingStream::class);
        $stream = $GLOBALS['rawFixtureSource'] = fopen('rawfixture://generated', 'rb');
        $encoding = $_GET['encoding'] ?? '';
        if (!$encoding) { return $stream; }
        $literal = \MailSo\Base\StreamWrappers\Literal::CreateStream($stream, RawCountingStream::$wireSize);
        return \MailSo\Base\StreamWrappers\Binary::CreateStream($literal,
            \MailSo\Base\StreamWrappers\Binary::GetInlineDecodeOrEncodeFunctionName($encoding));
    }
    $stream = fopen('php://temp', 'w+b');
    $bytes = fixtureBytes();
    $encoding = $_GET['encoding'] ?? '';
    $encoded = 'base64' === $encoding ? base64_encode($bytes)
        : ('quoted-printable' === $encoding ? quoted_printable_encode($bytes) : $bytes);
    fwrite($stream, $encoded);
    rewind($stream);
    if ($encoding) {
        $literal = \MailSo\Base\StreamWrappers\Literal::CreateStream($stream, strlen($encoded));
        return \MailSo\Base\StreamWrappers\Binary::CreateStream($literal,
            \MailSo\Base\StreamWrappers\Binary::GetInlineDecodeOrEncodeFunctionName($encoding));
    }
    return $stream;
}
class RawCountingStream
{
    public $context;
    public static array $stats = ['read' => 0, 'maxRead' => 0, 'serviceRetained' => 0,
        'outputChunk' => 0, 'firstOutputRead' => null, 'stageBytes' => 0, 'closed' => false];
    public static int $wireSize = 0;
    private int $position = 0;
    private int $size = 0;
    private int $prefixSize = 0;
    private string $pattern = '';
    private string $tail = '';
    public function stream_open($path, $mode, $options, &$opened): bool
    {
        $decodedSize = min(9 * 1024 * 1024, max(0, (int) ($_GET['count'] ?? 0)));
        $encoding = $_GET['encoding'] ?? '';
        $rawPattern = implode('', array_map('chr', range(0, 255)));
        if ('base64' === $encoding) { $rawPattern = str_repeat($rawPattern, 3); }
        $encode = static function ($bytes) use ($encoding) {
            return 'base64' === $encoding ? base64_encode($bytes)
                : ('quoted-printable' === $encoding ? quoted_printable_encode($bytes) : $bytes);
        };
        $this->pattern = $encode($rawPattern);
        $this->prefixSize = intdiv($decodedSize, strlen($rawPattern)) * strlen($this->pattern);
        $this->tail = $encode(substr($rawPattern, 0, $decodedSize % strlen($rawPattern)));
        $this->size = self::$wireSize = $this->prefixSize + strlen($this->tail);
        return true;
    }
    public function stream_read($count)
    {
        self::$stats['serviceRetained'] = max(self::$stats['serviceRetained'], (int) ob_get_length());
        foreach (\MailSo\Base\ResourceRegistry::$Resources as $resource) {
            if (is_resource($resource)) {
                self::$stats['stageBytes'] = max(self::$stats['stageBytes'], fstat($resource)['size']);
            }
        }
        if (isset($_GET['failRead']) && $this->position >= 8192) { return false; }
        $count = min($count, $this->size - $this->position);
        $prefixCount = max(0, min($count, $this->prefixSize - $this->position));
        $width = strlen($this->pattern);
        $chunk = substr(str_repeat($this->pattern, (int) ceil(($prefixCount + $width - 1) / $width)),
            $this->position % $width, $prefixCount);
        $chunk .= substr($this->tail, max(0, $this->position - $this->prefixSize), $count - $prefixCount);
        $this->position += $count;
        self::$stats['read'] += $count;
        self::$stats['maxRead'] = max(self::$stats['maxRead'], $count);
        return $chunk;
    }
    public function stream_eof(): bool { return $this->position >= $this->size; }
    public function stream_stat(): array { return ['size' => 0]; }
    public function stream_seek($offset, $whence): bool { return false; }
    public function stream_close(): void { self::$stats['closed'] = true; }
}
class RawBoundaryAccount extends \RainLoop\Model\MainAccount
{
    public function Hash(): string { return 'synthetic-account'; }
}
class RawBoundaryImap extends \MailSo\Imap\ImapClient
{
    public function IsLoggined(): bool { return true; }
}
class RawBoundaryMail extends \MailSo\Mail\MailClient
{
    public function ImapClient(): \MailSo\Imap\ImapClient { return new RawBoundaryImap(); }
    public function MessageMimeStream($callback, string $folder, int $uid, string $index): bool
    {
        header('X-Fixture-Mail-Callback: yes');
        $stream = fixtureStream();
        try { $callback($stream, $_GET['type'] ?? '', $_GET['name'] ?? 'synthetic.bin', '1'); }
        finally { fclose($stream); }
        return true;
    }
}
class RawBoundaryFiles extends \RainLoop\Providers\Files
{
    public function __construct() {}
    public function GetFile(\RainLoop\Model\Account $account, string $key, string $mode = 'rb')
    {
        return fixtureStream();
    }
}
class RawBoundaryActions extends \RainLoop\Actions
{
    public function getAccountFromToken(bool $throw = true): ?\RainLoop\Model\Account { return new RawBoundaryAccount(); }
    protected function initMailClientConnection(): ?\RainLoop\Model\Account { return $this->getAccountFromToken(); }
    public function MailClient(): \MailSo\Mail\MailClient { return new RawBoundaryMail(); }
    public function FilesProvider(): \RainLoop\Providers\Files { return new RawBoundaryFiles(); }
}

$config = \RainLoop\Api::Config();
$config->Set('security', 'content_security_policy', isset($_GET['framing']) ? "frame-ancestors 'self'" : '');
$config->Set('debug', 'enable', isset($_GET['debug']));
$config->Set('labs', 'image_exif_auto_rotate', false);
$config->Set('webmail', 'compress_output', isset($_GET['compress']));
if (isset($_GET['compress'])) { ini_set('zlib.output_compression', '1'); }
$actions = isset($_GET['service']) ? \RainLoop\Api::Actions() : new RawBoundaryActions();
$key = ['accountHash' => isset($_GET['unauthorized']) ? 'other-account' : 'synthetic-account',
    'folder' => 'INBOX', 'uid' => 1, 'mimeIndex' => '1',
    'mimeType' => $_GET['keyType'] ?? '', 'fileName' => $_GET['keyName'] ?? ''];
if (isset($_GET['fileHash'])) { $key['fileHash'] = 'synthetic-file'; }
$rawKey = \MailSo\Base\Utils::UrlSafeBase64Encode(json_encode($key));
if (isset($_GET['service'])) {
    $account = new RawBoundaryAccount();
    (new ReflectionProperty(\RainLoop\Model\Account::class, 'sEmail'))->setValue($account, 'raw-fixture@example.test');
    foreach (['oMainAuthAccount' => $account, 'oMailClient' => new RawBoundaryMail(), 'oFilesProvider' => new RawBoundaryFiles()] as $property => $value) {
        (new ReflectionProperty(\RainLoop\Actions::class, $property))->setValue($actions, $value);
    }
    $_SERVER['QUERY_STRING'] = 'Raw/0/'.($_GET['action'] ?? 'View').'/'.$rawKey;
    // Observe output *outside* the actual Service-owned response buffer.
    ob_start(function ($bytes) {
        RawCountingStream::$stats['outputChunk'] = max(RawCountingStream::$stats['outputChunk'], strlen($bytes));
        if (strlen($bytes) && null === RawCountingStream::$stats['firstOutputRead']) {
            RawCountingStream::$stats['firstOutputRead'] = RawCountingStream::$stats['read'];
        }
        return $bytes;
    }, 1);
    $observerLevel = ob_get_level();
    $startMemory = memory_get_usage(true);
    if (function_exists('memory_reset_peak_usage')) { memory_reset_peak_usage(); }
    \RainLoop\Service::Handle();
    // Literal owns its borrowed connection; close only the fixture's source here.
    if (is_resource($GLOBALS['rawFixtureSource'] ?? null)) { fclose($GLOBALS['rawFixtureSource']); }
    while (ob_get_level() >= $observerLevel) { ob_end_flush(); }
    $id = $_GET['stats'] ?? '';
    if (preg_match('/\A[a-z0-9-]+\z/', $id)) {
        RawCountingStream::$stats['resources'] = count(\MailSo\Base\ResourceRegistry::$Resources);
        RawCountingStream::$stats['peakExtra'] = max(0, memory_get_peak_usage(true) - $startMemory);
        file_put_contents(APP_INDEX_ROOT_PATH.'stats-'.$id.'.json', json_encode(RawCountingStream::$stats));
    }
    return;
}
header('Referrer-Policy: no-referrer');
header('X-Content-Type-Options: nosniff');
\RainLoop\Api::getCSP()->setHeaders();
$service = new \RainLoop\ServiceActions(\MailSo\Base\Http::SingletonInstance(), $actions);
echo $service->SetPaths(['Raw', '0', $_GET['action'] ?? 'View', $rawKey])->ServiceRaw();
