<?php

require_once __DIR__ . '/backup-restore-prepend.php';

$sRepositoryRoot = dirname(__DIR__, 2);
$sRequestPath = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);

if ('/__test/plugin-state' === $sRequestPath) {
	$_ENV['SNAPPYMAIL_INCLUDE_AS_API'] = '1';
	require $sRepositoryRoot . '/index.php';

	$oConfig = \RainLoop\Api::Config();
	$sApplicationConfig = file_get_contents(APP_PRIVATE_DATA . 'configs/application.ini') ?: '';
	header('Content-Type: application/json; charset=utf-8');
	echo json_encode([
		'plugins_enabled' => (bool)$oConfig->Get('plugins', 'enable', false),
		'enabled_list' => $oConfig->Get('plugins', 'enabled_list', ''),
		'stale_enablement_config_preserved' => str_contains($sApplicationConfig, '[plugins]')
			&& str_contains($sApplicationConfig, 'enabled_list = "backup"'),
		'backup_plugin_readable' => is_readable(APP_PRIVATE_DATA . 'plugins/backup/index.php'),
		'plugin_sentinel_executed' => is_file((string)getenv('PETUJA_TEST_PLUGIN_SENTINEL')),
		'admin_login_configured' => 'admin' !== $oConfig->Get('security', 'admin_login', ''),
		'admin_password_configured' => (bool)$oConfig->Get('security', 'admin_password', '')
	]);
	return true;
}

if ('/__test/mailbox-session' === $sRequestPath) {
	$_ENV['SNAPPYMAIL_INCLUDE_AS_API'] = '1';
	require $sRepositoryRoot . '/index.php';

	$oActions = \RainLoop\Api::Actions();
	$sDomainName = strtolower(gethostname());
	$oDomain = $oActions->DomainProvider()->Load($sDomainName, true);
	if (!$oDomain) {
		http_response_code(500);
		echo '{"error":"mailbox test fixture setup failed"}';
		return true;
	}

	// Mint a real application mailbox session in temporary state without contacting IMAP.
	$sEmail = 'backup-restore-test@' . $sDomainName;
	$oAccount = new \RainLoop\Model\MainAccount();
	$oAccount->setCredentials(
		$oDomain,
		$sEmail,
		$sEmail,
		new \SnappyMail\SensitiveString(bin2hex(random_bytes(24)))
	);

	$sSessionToken = \RainLoop\Utils::GetSessionToken();
	if (!$oActions->StorageProvider()->Put(
		$oAccount,
		\RainLoop\Providers\Storage\Enumerations\StorageType::SESSION,
		$sSessionToken,
		'true'
	)) {
		http_response_code(500);
		echo '{"error":"mailbox test fixture setup failed"}';
		return true;
	}

	$oActions->SetAuthToken($oAccount);
	header('Content-Type: application/json; charset=utf-8');
	echo '{"ok":true}';
	return true;
}

unset($_ENV['SNAPPYMAIL_INCLUDE_AS_API']);
require $sRepositoryRoot . '/index.php';
