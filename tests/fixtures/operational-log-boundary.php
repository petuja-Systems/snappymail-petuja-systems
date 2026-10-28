<?php
// Actual dispatcher/logger boundaries with inert operations; no authentication is simulated.
if ('cli' !== PHP_SAPI || 2 !== count($argv)) {
    http_response_code(404);
    exit(1);
}
$repo = dirname(__DIR__, 2);
$root = $argv[1];
define('APP_INDEX_ROOT_PATH', $root . '/');
define('APP_DATA_FOLDER_PATH', $root . '/data/');
$_ENV['SNAPPYMAIL_INCLUDE_AS_API'] = '1';
$_SERVER['SERVER_NAME'] = $_SERVER['HTTP_HOST'] = '127.0.0.1';
$_SERVER['REMOTE_ADDR'] = '127.0.0.1';
$_SERVER['REQUEST_METHOD'] = 'POST';
$_SERVER['CONTENT_TYPE'] = 'application/x-www-form-urlencoded';
$_SERVER['REQUEST_TIME_FLOAT'] = microtime(true);
$markers = [];
foreach (['uri', 'sso', 'nested', 'key', 'response', 'output', 'header', 'form',
    'argument', 'upload', 'raw_path', 'raw_message', 'registered'] as $name) {
    $markers[$name] = bin2hex(random_bytes(18));
}
$markers['argument'] = 'M7ARG' . bin2hex(random_bytes(4));
$_SERVER['REQUEST_URI'] = '/?/Raw/LogFixture/' . $markers['uri'] . '?hash=' . $markers['sso'];
require $repo . '/snappymail/v/0.0.0/include.php';

class OperationalLogFixture extends \RainLoop\Actions
{
    public array $markers;
    public int $executions = 0;
    public function isTwoFactorJsonActionAllowed($action, bool $admin): bool { return true; }
    public function DoLogFixture(): array
    {
        ++$this->executions;
        echo $this->GetActionParam('unexpected', '');
        return $this->DefaultResponse(['nested' => $this->GetActionParam('nested'),
            'privateKey' => $this->markers['response']]);
    }
    public function DoLogFailure(): array
    {
        $this->failWithArgument($this->GetActionParam('proof'));
    }
    private function failWithArgument(string $value): void
    {
        throw new \RuntimeException('Synthetic diagnostic failure');
    }
    public function Upload(?array $file, int $error): array
    {
        echo $this->markers['upload'];
        return $this->DefaultResponse(['name' => $this->markers['upload']]);
    }
    public function RawLogFixture(): bool
    {
        throw new \RuntimeException($this->markers['raw_message']);
    }
}
$actions = new OperationalLogFixture();
$actions->markers = $markers;
$service = new \RainLoop\ServiceActions(\MailSo\Base\Http::SingletonInstance(), $actions);
$token = \RainLoop\Utils::GetCsrfToken();
$_SERVER['HTTP_X_SM_TOKEN'] = $token;
$_POST = ['Action' => 'LogFixture', 'XToken' => $token, 'privateKey' => $markers['key'],
    'nested' => ['unclassified' => $markers['nested']], 'unexpected' => $markers['output']];
$body = json_decode($service->ServiceJson(), true);
$result = ['response_preserved' => ($body['Result']['privateKey'] ?? null) === $markers['response']
    && ($body['Result']['nested']['unclassified'] ?? null) === $markers['nested']];

$_SERVER['HTTP_X_SM_TOKEN'] = $markers['header'];
$headerFailure = json_decode($service->ServiceJson(), true);
unset($_SERVER['HTTP_X_SM_TOKEN']);
$_POST['XToken'] = $markers['form'];
$formFailure = json_decode($service->ServiceJson(), true);
$result['csrf_rejection_preserved'] = ($headerFailure['code'] ?? null) === \RainLoop\Notifications::InvalidToken
    && ($formFailure['code'] ?? null) === \RainLoop\Notifications::InvalidToken && $actions->executions === 1;

$_SERVER['HTTP_X_SM_TOKEN'] = $token;
$_POST = ['Action' => 'LogFailure', 'proof' => $markers['argument']];
$failure = json_decode($service->ServiceJson(), true);
$result['exception_response_preserved'] = false === ($failure['Result'] ?? null);

$uploadFile = $root . '/upload.fixture';
file_put_contents($uploadFile, 'Harmless local fixture');
$_FILES = ['uploader' => ['name' => 'fixture.txt', 'tmp_name' => $uploadFile, 'size' => 22, 'error' => UPLOAD_ERR_OK]];
$uploaded = json_decode($service->ServiceUpload(), true);
$result['upload_response_preserved'] = ($uploaded['Result']['name'] ?? null) === $markers['upload'];
$service->SetPaths(['Raw', '', 'LogFixture', $markers['raw_path']])->ServiceRaw();

$logger = $actions->Logger();
$logger->AddSecret($markers['registered']);
$logger->__phpExceptionHandler(new \RuntimeException('Synthetic registered diagnostic ' . $markers['registered']));
$log = file_get_contents(APP_PRIVATE_DATA . 'logs/operational.log');
$nativeLog = file_get_contents($root . '/php.log');
foreach ($markers as $name => $marker) {
    $result['absent_' . $name] = !str_contains($log, $marker);
}
$result['csrf_expected_absent'] = !str_contains($log, $token);
$result['native_registered_absent'] = !str_contains($nativeLog, $markers['registered']);
$result['masking_retained'] = str_contains($log, '*******') && str_contains($nativeLog, '*******');
$result['action_metadata_retained'] = str_contains($log, 'Action: DoLogFixture')
    && str_contains($log, 'Action: RawLogFixture');
$result['trace_metadata_retained'] = str_contains($log, 'failWithArgument()')
    && false !== stripos($log, 'ServiceActions.php');
$result['diagnostic_message_retained'] = str_contains($log, 'Synthetic diagnostic failure');
$result['omission_markers_retained'] = str_contains($log, '[request body omitted]')
    && str_contains($log, '[response body omitted]') && str_contains($log, '[unexpected output omitted]')
    && str_contains($log, '[upload response body omitted]');
$result['legacy_error_mapping'] = \MailSo\Log\Logger::PHP_TYPES[2048] === LOG_CRIT
    && \MailSo\Log\Logger::PHP_TYPE_POSTFIX[2048] === '-STRICT';
$result['no_strict_deprecation'] = !str_contains($log . $nativeLog, 'E_STRICT is deprecated');
echo json_encode($result, JSON_THROW_ON_ERROR);
