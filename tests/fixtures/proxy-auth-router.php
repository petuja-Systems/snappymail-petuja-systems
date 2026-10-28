<?php

require_once __DIR__ . '/backup-restore-prepend.php';

$sRepositoryRoot = dirname(__DIR__, 2);
$sRequestPath = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
$sFixtureSecret = getenv('PETUJA_TEST_FIXTURE_SECRET') ?: '';
$sRequestSecret = $_SERVER['HTTP_X_TEST_FIXTURE_SECRET'] ?? '';
$bFixtureRequest = '' !== $sFixtureSecret && is_string($sRequestSecret)
	&& hash_equals($sFixtureSecret, $sRequestSecret);

if (str_starts_with($sRequestPath, '/__test/') && !$bFixtureRequest) {
	http_response_code(404);
	return true;
}

if ('/__test/plugin-state' === $sRequestPath && $bFixtureRequest) {
	$_ENV['SNAPPYMAIL_INCLUDE_AS_API'] = '1';
	require $sRepositoryRoot . '/index.php';

	$oActions = \RainLoop\Api::Actions();
	$oConfig = \RainLoop\Api::Config();
	$sApplicationConfig = file_get_contents(APP_PRIVATE_DATA . 'configs/application.ini') ?: '';
	header('Content-Type: application/json; charset=utf-8');
	echo json_encode([
		'plugins_enabled' => (bool)$oConfig->Get('plugins', 'enable', false),
		'enabled_list' => $oConfig->Get('plugins', 'enabled_list', ''),
		'stale_enablement_config_preserved' => str_contains($sApplicationConfig, '[plugins]')
			&& str_contains($sApplicationConfig, 'enabled_list = "proxy-auth"'),
		'plugin_file_readable' => is_readable(APP_PRIVATE_DATA . 'plugins/proxy-auth/index.php'),
		'plugin_config_exists' => is_file(APP_PRIVATE_DATA . 'configs/plugin-proxy-auth.json'),
		'plugin_sentinel_executed' => is_file((string)getenv('PETUJA_TEST_PLUGIN_SENTINEL')),
		'authenticated' => (bool)$oActions->getMainAccountFromToken(false)
	]);
	return true;
}

unset($_ENV['SNAPPYMAIL_INCLUDE_AS_API']);
require $sRepositoryRoot . '/index.php';
