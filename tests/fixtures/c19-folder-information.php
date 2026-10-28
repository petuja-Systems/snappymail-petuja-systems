<?php

declare(strict_types=1);

$libraries = dirname(__DIR__, 2) . '/snappymail/v/0.0.0/app/libraries';
spl_autoload_register(static function (string $class) use ($libraries): void {
	$path = str_replace('\\', '/', $class) . '.php';
	foreach ([$path, strtolower($path)] as $name) {
		if (is_file($libraries . '/' . $name)) {
			require_once $libraries . '/' . $name;
			return;
		}
	}
});
require $libraries . '/RainLoop/Actions/Folders.php';

final class C19CountingMailClient
{
	public int $folderInformationCalls = 0;
	public array $requestedFolders = [];
	public array $failingFolders = [];

	public function FolderInformation(string $folder): array
	{
		++$this->folderInformationCalls;
		$this->requestedFolders[] = $folder;
		if (in_array($folder, $this->failingFolders, true)) {
			throw new RuntimeException('Synthetic folder-status failure');
		}
		return ['name' => $folder];
	}
}

final class C19FolderActionHarness
{
	use \RainLoop\Actions\Folders;

	public array $params = [];
	public bool $authenticated = true;
	public int $authenticationChecks = 0;
	public int $imapConnections = 0;
	public int $loggedFolderFailures = 0;
	public C19CountingMailClient $mailClient;

	public function __construct()
	{
		$this->mailClient = new C19CountingMailClient();
	}

	public function GetActionParam(string $key, $default = null)
	{
		return array_key_exists($key, $this->params) ? $this->params[$key] : $default;
	}

	public function GetActionParams(): array
	{
		return $this->params;
	}

	public function getAccountFromToken()
	{
		++$this->authenticationChecks;
		if (!$this->authenticated) {
			throw new \RainLoop\Exceptions\ClientException(\RainLoop\Notifications::AuthError);
		}
		return new stdClass();
	}

	public function initMailClientConnection(): void
	{
		++$this->imapConnections;
		$this->getAccountFromToken();
	}

	public function MailClient(): C19CountingMailClient
	{
		return $this->mailClient;
	}

	public function DefaultResponse($result): array
	{
		return ['Result' => $result];
	}

	public function logException(Throwable $exception): void
	{
		++$this->loggedFolderFailures;
	}

	public function invoke(): array
	{
		try {
			$response = $this->DoFolderInformationMultiply();
			$code = 0;
		} catch (Throwable $exception) {
			$response = null;
			$code = $exception->getCode();
		}

		return [
			'code' => $code,
			'result' => $response['Result'] ?? null,
			'folders' => $this->mailClient->requestedFolders,
			'authenticationChecks' => $this->authenticationChecks,
			'imapConnections' => $this->imapConnections,
			'folderInformationCalls' => $this->mailClient->folderInformationCalls,
			'loggedFolderFailures' => $this->loggedFolderFailures
		];
	}
}

$mode = $argv[1] ?? '';
if ('large' === $mode) {
	$aFolders = array_map(static fn (int $i): string => 'synthetic-' . $i, range(1, 50000));
	$aRequest = ['folders' => $aFolders];
} else if ('duplicates' === $mode) {
	$aRequest = ['folders' => array_fill(0, 20000, 'INBOX')];
} else if ('recovery' === $mode) {
	$oHarness = new C19FolderActionHarness();
	$oHarness->params = ['folders' => array_map(static fn (int $i): string => 'folder-' . $i, range(1, 11))];
	$aRejected = $oHarness->invoke();
	$oHarness->params = ['folders' => ['INBOX']];
	$aRecovered = $oHarness->invoke();
	echo json_encode(['rejected' => $aRejected, 'recovered' => $aRecovered], JSON_THROW_ON_ERROR);
	exit;
} else {
	$aRequest = json_decode($mode, true, 512, JSON_THROW_ON_ERROR);
}

$oHarness = new C19FolderActionHarness();
$oHarness->params = is_array($aRequest) ? $aRequest : [];
$oHarness->authenticated = !is_array($aRequest) || ($aRequest['authenticated'] ?? true) !== false;
$oHarness->mailClient->failingFolders = is_array($aRequest) && is_array($aRequest['failingFolders'] ?? null)
	? $aRequest['failingFolders']
	: [];
echo json_encode($oHarness->invoke(), JSON_THROW_ON_ERROR);
